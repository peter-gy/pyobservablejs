"""Awaitable data access for widget views and optional headless execution."""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from typing import TYPE_CHECKING, Any, Protocol, cast

from . import _conversions as convert
from . import errors
from ._data_types import (
    DataCatalog,
    DataDescription,
    DatasetCollection,
    DataSource,
    decode_description,
    sources_for,
    variable_cell,
)
from ._inspection import (
    DatasetInfo,
    NotebookInspection,
    ReadFormat,
    decode_datasets,
    decode_inspection,
    read_parameters,
)

if TYPE_CHECKING:
    import pandas
    import polars
    import pyarrow

    from ._data import NotebookData
    from ._execution import Evaluation
    from ._notebook import Notebook, NotebookCell
    from ._view import NotebookView
    from .types import CellSelector


class AsyncAccess(Protocol):
    @property
    def notebook(self) -> Notebook: ...
    @property
    def inspection(self) -> NotebookInspection | None: ...
    @property
    def scope(self) -> int | None: ...
    async def request(
        self,
        name: str | None,
        pinned: DatasetInfo | None,
        operation: str,
        *,
        timeout: float | None,
        format: ReadFormat = "json",
        columns: Sequence[str] | None = None,
        offset: int = 0,
        limit: int | None = None,
        path: Sequence[str | int] = (),
    ) -> object: ...


class AsyncDataReference:
    def __init__(
        self,
        access: AsyncAccess,
        name: str | None,
        *,
        pinned: DatasetInfo | None = None,
    ) -> None:
        self._access = access
        self._name = name
        self._pinned = pinned

    @property
    def name(self) -> str | None:
        return self._name

    @property
    def cell(self) -> NotebookCell | None:
        if self._pinned is not None:
            return self._pinned.cell
        inspection = self._access.inspection
        return (
            variable_cell(inspection, self.name, self._access.scope)
            if inspection is not None and self.name is not None
            else None
        )

    @property
    def sources(self) -> tuple[DataSource, ...] | None:
        inspection = self._access.inspection
        cell = self.cell
        return (
            sources_for(inspection, cell.index)
            if inspection is not None and cell is not None
            else None
        )

    async def describe(self, *, timeout: float | None = 30) -> DataDescription:
        value = await self._access.request(
            self.name, self._pinned, "describe", timeout=timeout
        )
        return decode_description(value)

    async def _read(
        self,
        format: ReadFormat,
        *,
        columns: Sequence[str] | None = None,
        offset: int = 0,
        limit: int | None = None,
        path: Sequence[str | int] = (),
        timeout: float | None = 30,
    ) -> Any:
        return await self._access.request(
            self.name,
            self._pinned,
            "read",
            timeout=timeout,
            format=format,
            columns=columns,
            offset=offset,
            limit=limit,
            path=path,
        )

    async def to_python(
        self,
        *,
        columns: Sequence[str] | None = None,
        offset: int = 0,
        limit: int | None = None,
        path: Sequence[str | int] = (),
        timeout: float | None = 30,
    ) -> object:
        return await self._read(
            "python",
            columns=columns,
            offset=offset,
            limit=limit,
            path=path,
            timeout=timeout,
        )

    async def to_polars(
        self,
        *,
        columns: Sequence[str] | None = None,
        offset: int = 0,
        limit: int | None = None,
        path: Sequence[str | int] = (),
        timeout: float | None = 30,
    ) -> polars.DataFrame:
        convert.require_library("polars")
        return await asyncio.to_thread(
            convert.polars_frame,
            await self._read(
                "arrow",
                columns=columns,
                offset=offset,
                limit=limit,
                path=path,
                timeout=timeout,
            ),
        )

    async def to_pandas(
        self,
        *,
        columns: Sequence[str] | None = None,
        offset: int = 0,
        limit: int | None = None,
        path: Sequence[str | int] = (),
        timeout: float | None = 30,
    ) -> pandas.DataFrame:
        convert.require_library("pandas", "pyarrow")
        return await asyncio.to_thread(
            convert.pandas_frame,
            await self._read(
                "arrow",
                columns=columns,
                offset=offset,
                limit=limit,
                path=path,
                timeout=timeout,
            ),
        )

    async def to_arrow(
        self,
        *,
        columns: Sequence[str] | None = None,
        offset: int = 0,
        limit: int | None = None,
        path: Sequence[str | int] = (),
        timeout: float | None = 30,
    ) -> pyarrow.Table:
        convert.require_library("pyarrow")
        return await asyncio.to_thread(
            convert.arrow_table,
            await self._read(
                "arrow",
                columns=columns,
                offset=offset,
                limit=limit,
                path=path,
                timeout=timeout,
            ),
        )

    def __repr__(self) -> str:
        return f"AsyncDataReference({self.name!r})"


class ViewData:
    def __init__(self, view: NotebookView) -> None:
        self._view = view

    @property
    def notebook(self) -> Notebook:
        return self._view.notebook

    @property
    def inspection(self) -> NotebookInspection | None:
        return self._view.inspection

    @property
    def scope(self) -> int | None:
        return None

    def __getitem__(self, name: str) -> AsyncDataReference:
        if not isinstance(name, str) or not name:
            raise TypeError("data names must be non-empty strings")
        return AsyncDataReference(self, name)

    async def _inspection(self, timeout: float | None = 30) -> NotebookInspection:
        reply = await self._view._requests.request({"operation": "inspect"}, timeout)
        inspection = decode_inspection(reply.result, self.notebook)
        self.notebook._analysis_cache = inspection
        return inspection

    async def names(self, *, timeout: float | None = 30) -> tuple[str, ...]:
        inspection = await self._inspection(timeout)
        return tuple(
            dict.fromkeys(name for cell in inspection.cells for name in cell.defines)
        )

    async def request(
        self,
        name: str | None,
        pinned: DatasetInfo | None,
        operation: str,
        *,
        timeout: float | None,
        format: ReadFormat = "json",
        columns: Sequence[str] | None = None,
        offset: int = 0,
        limit: int | None = None,
        path: Sequence[str | int] = (),
    ) -> object:
        selector = pinned if pinned is not None else name
        if selector is None:
            raise ValueError("A data reference requires a name or discovered dataset")
        if operation == "read":
            return (
                await self._view._read(
                    selector,
                    path=path,
                    format=format,
                    columns=columns,
                    offset=offset,
                    limit=limit,
                    timeout=timeout,
                )
            ).data
        parameters = read_parameters(
            self.notebook,
            self._view._requests.identity,
            self._view._requests.generation,
            selector,
            name=None,
            path=path,
            format=format,
            columns=columns,
            offset=offset,
            limit=limit,
        )
        reply = await self._view._requests.request(
            {"operation": operation, **parameters}, timeout
        )
        return reply.result

    async def discover(
        self, *, timeout: float | None = 30
    ) -> DataCatalog[AsyncDataReference]:
        reply = await self._view._requests.request(
            {
                "operation": "discover",
                "deadline": timeout * 900 if timeout is not None else None,
            },
            timeout,
        )
        value: Any = reply.result
        if (
            not isinstance(value, dict)
            or set(value) != {"datasets", "errors", "pending"}
            or type(value["pending"]) is not bool
        ):
            raise errors.ProtocolError("Invalid data catalog")
        value = cast(dict[str, Any], value)
        datasets = decode_datasets(
            value["datasets"],
            self.notebook,
            reply.generation,
            self._view._requests.identity,
        )
        references = [
            AsyncDataReference(self, info.name, pinned=info) for info in datasets
        ]
        return DataCatalog(
            DatasetCollection(references),
            tuple(errors._diagnostic_from_wire(item) for item in value["errors"]),
            value["pending"],
        )


class AsyncNotebookData:
    def __init__(self, access: NotebookData, session: Evaluation | None = None) -> None:
        self._access = access
        self._session = session

    @property
    def notebook(self) -> Notebook:
        return self._access._notebook

    @property
    def inspection(self) -> NotebookInspection | None:
        return self.notebook._analysis_cache

    @property
    def scope(self) -> int | None:
        return self._access._scope

    def __getitem__(self, name: str) -> AsyncDataReference:
        if not isinstance(name, str) or not name:
            raise TypeError("data names must be non-empty strings")
        return AsyncDataReference(self, name)

    async def names(self) -> tuple[str, ...]:
        await self._access._inspection_async()
        return self._access.names()

    async def request(
        self,
        name: str | None,
        pinned: DatasetInfo | None,
        operation: str,
        *,
        timeout: float | None,
        format: ReadFormat = "json",
        columns: Sequence[str] | None = None,
        offset: int = 0,
        limit: int | None = None,
        path: Sequence[str | int] = (),
    ) -> object:
        if self._session is not None:
            session = self._session
        else:
            if name is None:
                raise ValueError("A variable name is required")
            inspection = await self._access._inspection_async()
            cell = variable_cell(inspection, name, self.scope)
            session = await self._access._pool.acquire_async(
                (cell.index,), timeout, reuse_enclosing=True
            )
        selector, selected_name = self._access._selection(name, pinned)
        if operation == "read":
            return (
                await session.read_async(
                    selector,
                    name=selected_name,
                    path=path,
                    format=format,
                    columns=columns,
                    offset=offset,
                    limit=limit,
                    timeout=timeout,
                )
            ).data
        return await session.describe_async(
            selector, name=selected_name, path=path, timeout=timeout
        )

    async def discover(
        self, *selectors: CellSelector, timeout: float | None = 30
    ) -> DataCatalog[AsyncDataReference]:
        indexes = (
            tuple(self.notebook._normalize_view_cells(selectors))
            if selectors
            else (self.scope,)
            if self.scope is not None
            else ()
        )
        session = await self._access._pool.acquire_async(indexes, timeout)
        reply = await session.request_async(
            "discover",
            timeout=timeout,
            deadline=timeout * 900 if timeout is not None else None,
        )
        session._accept(reply)
        self.notebook._analysis_cache = session.inspection
        access = AsyncNotebookData(self._access, session)
        return DataCatalog(
            DatasetCollection(
                [
                    AsyncDataReference(access, info.name, pinned=info)
                    for info in session.datasets
                ]
            ),
            session.diagnostics,
            session.state.pending,
        )
