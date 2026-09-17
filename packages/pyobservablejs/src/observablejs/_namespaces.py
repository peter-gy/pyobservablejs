"""Cell identity, static dependency inspection, and rendered artifacts."""

from __future__ import annotations

from collections.abc import Iterator, Sequence
from typing import TYPE_CHECKING, overload

from ._graph import dependency_indexes

if TYPE_CHECKING:
    from ._graph import NotebookGraph
    from ._inspection import ImportInfo
    from ._notebook import Notebook, NotebookCell
    from ._view import NotebookView
    from .types import CellSelector


class Cells(Sequence["NotebookCell"]):
    def __init__(
        self, notebook: Notebook, indexes: Sequence[int] | None = None
    ) -> None:
        self._notebook = notebook
        self._indexes = (
            tuple(range(len(notebook._nodes))) if indexes is None else tuple(indexes)
        )

    @overload
    def __getitem__(self, key: str | int) -> NotebookCell: ...
    @overload
    def __getitem__(self, key: slice) -> tuple[NotebookCell, ...]: ...
    def __getitem__(
        self, key: str | int | slice
    ) -> NotebookCell | tuple[NotebookCell, ...]:
        if isinstance(key, str):
            matches = [
                index
                for index in self._indexes
                if self._notebook._controller._cell_keys[index] == key and key
            ]
            if len(matches) != 1:
                raise KeyError(
                    f"{'Ambiguous' if matches else 'Unknown'} Observable cell key: {key!r}"
                )
            return self._notebook._cell_at(matches[0])
        if isinstance(key, slice):
            return tuple(self._notebook._cell_at(index) for index in self._indexes[key])
        if type(key) is not int:
            raise TypeError("cell selection must be a key or position")
        return self._notebook._cell_at(self._indexes[key])

    def __len__(self) -> int:
        return len(self._indexes)

    def __iter__(self) -> Iterator[NotebookCell]:
        return (self._notebook._cell_at(index) for index in self._indexes)

    def keys(self) -> tuple[str, ...]:
        return tuple(cell.key for cell in self if cell.key is not None)


class Graph:
    def __init__(self, notebook: Notebook) -> None:
        self._notebook = notebook

    def snapshot(self) -> NotebookGraph:
        return self._notebook.data._inspection().graph

    def imports(self) -> tuple[ImportInfo, ...]:
        return self._notebook.data._inspection().imports

    def upstream(
        self, selector: CellSelector, *, transitive: bool = True
    ) -> tuple[NotebookCell, ...]:
        return self._walk(selector, upstream=True, transitive=transitive)

    def downstream(
        self, selector: CellSelector, *, transitive: bool = True
    ) -> tuple[NotebookCell, ...]:
        return self._walk(selector, upstream=False, transitive=transitive)

    def _walk(
        self, selector: CellSelector, *, upstream: bool, transitive: bool
    ) -> tuple[NotebookCell, ...]:
        index = self._notebook._normalize_view_cells([selector])[0]
        return tuple(
            self._notebook._cell_at(item)
            for item in dependency_indexes(
                self.snapshot(), index, upstream=upstream, transitive=transitive
            )
        )

    def to_mermaid(self) -> str:
        return self.snapshot().to_mermaid()

    def to_d2(self) -> str:
        return self.snapshot().to_d2()


class Render:
    def __init__(self, notebook: Notebook) -> None:
        self._notebook = notebook

    def png(
        self,
        *selectors: CellSelector,
        network: bool | Sequence[str] = True,
        timeout: float | None = 30,
    ) -> bytes:
        from ._execution import Evaluation

        with Evaluation(
            self._notebook,
            selectors,
            engine="chromium",
            network=network,
            timeout=timeout,
        ) as evaluation:
            evaluation.ready(timeout=timeout)
            return evaluation.screenshot(timeout=timeout)


class ViewGraph:
    def __init__(self, view: NotebookView) -> None:
        self._view = view

    async def snapshot(self, *, timeout: float | None = 30) -> NotebookGraph:
        return (await self._view.data._inspection(timeout)).graph

    async def imports(self, *, timeout: float | None = 30) -> tuple[ImportInfo, ...]:
        return (await self._view.data._inspection(timeout)).imports

    async def upstream(
        self,
        selector: CellSelector,
        *,
        transitive: bool = True,
        timeout: float | None = 30,
    ) -> tuple[NotebookCell, ...]:
        graph = await self.snapshot(timeout=timeout)
        notebook = self._view.notebook
        index = notebook._normalize_view_cells([selector])[0]
        return tuple(
            notebook._cell_at(item)
            for item in dependency_indexes(graph, index, transitive=transitive)
        )

    async def downstream(
        self,
        selector: CellSelector,
        *,
        transitive: bool = True,
        timeout: float | None = 30,
    ) -> tuple[NotebookCell, ...]:
        graph = await self.snapshot(timeout=timeout)
        notebook = self._view.notebook
        index = notebook._normalize_view_cells([selector])[0]
        return tuple(
            notebook._cell_at(item)
            for item in dependency_indexes(
                graph, index, upstream=False, transitive=transitive
            )
        )
