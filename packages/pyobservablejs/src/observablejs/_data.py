"""Synchronous notebook data references backed by optional execution."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import TYPE_CHECKING, Any, Literal

from . import _conversions as convert
from ._data_types import (
    DataCatalog,
    DataDescription,
    DatasetCollection,
    DataSource,
    decode_description,
    sources_for,
    variable_cell,
)
from ._evaluation_pool import _EvaluationPool
from ._inspection import DatasetInfo, NotebookInspection, ReadFormat

if TYPE_CHECKING:
    import pandas
    import polars
    import pyarrow

    from ._async_data import AsyncNotebookData
    from ._execution import Evaluation
    from ._notebook import Notebook, NotebookCell
    from .types import CellSelector


class NotebookData:
    def __init__(
        self,
        notebook: Notebook,
        *,
        scope: int | None = None,
        engine: Literal["deno", "chromium"] = "deno",
        network: bool | Sequence[str] = True,
        resolve_notebook: Callable[[str], Notebook] | None = None,
        _pool: _EvaluationPool | None = None,
    ) -> None:
        self._notebook = notebook
        self._scope = scope
        self._pool = _pool or _EvaluationPool(
            notebook, engine, network, resolve_notebook
        )

    def _scoped(self, index: int) -> NotebookData:
        return NotebookData(self._notebook, scope=index, _pool=self._pool)

    @property
    def aio(self) -> AsyncNotebookData:
        from ._async_data import AsyncNotebookData

        return AsyncNotebookData(self)

    def using(
        self,
        *,
        engine: Literal["deno", "chromium"] = "deno",
        network: bool | Sequence[str] = True,
        resolve_notebook: Callable[[str], Notebook] | None = None,
    ) -> NotebookData:
        if engine not in {"deno", "chromium"}:
            raise ValueError("engine must be deno or chromium")
        return NotebookData(
            self._notebook,
            scope=self._scope,
            engine=engine,
            network=network,
            resolve_notebook=resolve_notebook,
        )

    def _inspection(self) -> NotebookInspection:
        self._notebook._controller._require_open()
        if self._notebook._analysis_cache is None:
            from ._execution import inspect_definition

            self._notebook._analysis_cache = inspect_definition(self._notebook)
        return self._notebook._analysis_cache

    async def _inspection_async(self) -> NotebookInspection:
        self._notebook._controller._require_open()
        if self._notebook._analysis_cache is None:
            from ._execution import inspect_definition_async

            self._notebook._analysis_cache = await inspect_definition_async(
                self._notebook
            )
        return self._notebook._analysis_cache

    def names(self) -> tuple[str, ...]:
        return tuple(
            dict.fromkeys(
                name
                for cell in self._inspection().cells
                if self._scope is None or cell.index == self._scope
                for name in cell.defines
            )
        )

    def __getitem__(self, name: str) -> DataReference:
        if not isinstance(name, str) or not name:
            raise TypeError("data names must be non-empty strings")
        variable_cell(self._inspection(), name, self._scope)
        return DataReference(self, name)

    def _selection(
        self, name: str | None, pinned: DatasetInfo | None
    ) -> tuple[str | NotebookCell | DatasetInfo, str | None]:
        if pinned is not None:
            return pinned, None
        if name is None:
            raise ValueError("A data reference requires a name or discovered dataset")
        if self._scope is not None:
            return self._notebook._cell_at(self._scope), name
        return name, None

    def discover(
        self, *selectors: CellSelector, timeout: float | None = 30
    ) -> DataCatalog[DataReference]:
        indexes = (
            tuple(self._notebook._normalize_view_cells(selectors))
            if selectors
            else (self._scope,)
            if self._scope is not None
            else ()
        )
        session = self._pool.acquire(indexes, timeout)
        session.discover(timeout=timeout)
        self._notebook._analysis_cache = session.inspection
        references = [
            DataReference(self, info.name, pinned=info, evaluation=session)
            for info in session.datasets
        ]
        return DataCatalog(
            DatasetCollection(references), session.diagnostics, session.state.pending
        )


class DataReference:
    def __init__(
        self,
        access: NotebookData,
        name: str | None,
        *,
        pinned: DatasetInfo | None = None,
        evaluation: Evaluation | None = None,
    ) -> None:
        self._access = access
        self._name = name
        self._pinned = pinned
        self._session = evaluation

    @property
    def name(self) -> str | None:
        return self._name

    @property
    def cell(self) -> NotebookCell | None:
        if self._pinned is not None:
            return self._pinned.cell
        if self._access._scope is not None:
            return self._access._notebook._cell_at(self._access._scope)
        inspection = self._access._notebook._analysis_cache
        return (
            variable_cell(inspection, self._name)
            if inspection is not None and self._name is not None
            else None
        )

    @property
    def sources(self) -> tuple[DataSource, ...] | None:
        inspection = self._access._notebook._analysis_cache
        cell = self.cell
        return (
            sources_for(inspection, cell.index)
            if inspection is not None and cell is not None
            else None
        )

    def _evaluation(self, timeout: float | None) -> Evaluation:
        if self._session is not None:
            return self._session
        inspection = self._access._inspection()
        if self._name is None:
            raise ValueError("Anonymous data requires a discovered reference")
        cell = variable_cell(inspection, self._name, self._access._scope)
        return self._access._pool.acquire((cell.index,), timeout, reuse_enclosing=True)

    def _read(
        self,
        format: ReadFormat,
        *,
        columns: Sequence[str] | None = None,
        offset: int = 0,
        limit: int | None = None,
        path: Sequence[str | int] = (),
        timeout: float | None = 30,
    ) -> Any:
        session = self._evaluation(timeout)
        selected, name = self._access._selection(self._name, self._pinned)
        result = session.read(
            selected,
            name=name,
            path=path,
            format=format,
            columns=columns,
            offset=offset,
            limit=limit,
            timeout=timeout,
        )
        return result.data

    def to_python(
        self,
        *,
        columns: Sequence[str] | None = None,
        offset: int = 0,
        limit: int | None = None,
        path: Sequence[str | int] = (),
        timeout: float | None = 30,
    ) -> object:
        return self._read(
            "python",
            columns=columns,
            offset=offset,
            limit=limit,
            path=path,
            timeout=timeout,
        )

    def to_polars(
        self,
        *,
        columns: Sequence[str] | None = None,
        offset: int = 0,
        limit: int | None = None,
        path: Sequence[str | int] = (),
        timeout: float | None = 30,
    ) -> polars.DataFrame:
        convert.require_library("polars")
        return convert.polars_frame(
            self._read(
                "arrow",
                columns=columns,
                offset=offset,
                limit=limit,
                path=path,
                timeout=timeout,
            )
        )

    def to_pandas(
        self,
        *,
        columns: Sequence[str] | None = None,
        offset: int = 0,
        limit: int | None = None,
        path: Sequence[str | int] = (),
        timeout: float | None = 30,
    ) -> pandas.DataFrame:
        convert.require_library("pandas", "pyarrow")
        return convert.pandas_frame(
            self._read(
                "arrow",
                columns=columns,
                offset=offset,
                limit=limit,
                path=path,
                timeout=timeout,
            )
        )

    def to_arrow(
        self,
        *,
        columns: Sequence[str] | None = None,
        offset: int = 0,
        limit: int | None = None,
        path: Sequence[str | int] = (),
        timeout: float | None = 30,
    ) -> pyarrow.Table:
        convert.require_library("pyarrow")
        return convert.arrow_table(
            self._read(
                "arrow",
                columns=columns,
                offset=offset,
                limit=limit,
                path=path,
                timeout=timeout,
            )
        )

    def describe(self, *, timeout: float | None = 30) -> DataDescription:
        session = self._evaluation(timeout)
        selector, name = self._access._selection(self._name, self._pinned)
        return decode_description(
            session.describe(selector, name=name, timeout=timeout)
        )

    def __repr__(self) -> str:
        return f"DataReference({self.name!r})"
