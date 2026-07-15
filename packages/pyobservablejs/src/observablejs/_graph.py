"""Immutable Python view of browser-produced Notebook Kit graph metadata."""

from __future__ import annotations

import dataclasses
from collections.abc import Iterable, Mapping
from typing import Any

from ._graph_diagram import graph_to_d2, graph_to_mermaid


@dataclasses.dataclass(frozen=True)
class DependencyEdge:
    """A symbolic dependency between two notebook cells."""

    source_id: int
    target_id: int
    variable: str


@dataclasses.dataclass(frozen=True)
class CellInfo:
    """Notebook Kit symbolic metadata for one rendered cell.

    ``defines`` names Python-visible variables exposed by the cell.
    ``references`` names variables read by the cell. ``outputs`` are Notebook Kit
    declarations, and ``runtime_outputs`` are the raw runtime names used for
    dependency edges. The auto flags mirror Notebook Kit display, ``viewof``, and
    mutable output handling.
    """

    id: int
    index: int
    mode: str
    key: str | None
    name: str | None
    defines: tuple[str, ...]
    references: tuple[str, ...]
    output: str | None
    outputs: tuple[str, ...]
    runtime_outputs: tuple[str, ...]
    autodisplay: bool
    autoview: bool
    automutable: bool
    error: str | None = None


@dataclasses.dataclass(frozen=True)
class NotebookGraph:
    """Symbolic graph for the cells evaluated by one ``NotebookView``."""

    cells: tuple[CellInfo, ...]
    edges: tuple[DependencyEdge, ...]

    @property
    def defines(self) -> tuple[str, ...]:
        return _unique(name for cell in self.cells for name in cell.defines)

    @property
    def references(self) -> tuple[str, ...]:
        return _unique(name for cell in self.cells for name in cell.references)

    @property
    def external_references(self) -> tuple[str, ...]:
        defined = set(self.defines)
        defined.update(name for cell in self.cells for name in cell.runtime_outputs)
        return tuple(name for name in self.references if name not in defined)

    def cell(self, index: int) -> CellInfo | None:
        for cell in self.cells:
            if cell.index == index:
                return cell
        return None

    def cell_for_variable(self, variable: str) -> CellInfo:
        matches = [cell for cell in self.cells if variable in cell.defines]
        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            raise KeyError(f"Ambiguous Observable variable: {variable!r}")
        raise KeyError(f"Unknown Observable variable: {variable!r}")

    def to_mermaid(self) -> str:
        """Return a Mermaid flowchart for the notebook dependency graph."""

        return graph_to_mermaid(self)

    def to_d2(self) -> str:
        """Return a D2 diagram for the notebook dependency graph."""

        return graph_to_d2(self)


def graph_from_raw(raw: Any) -> NotebookGraph | None:
    """Decode synced graph metadata into immutable public objects."""

    if (
        not isinstance(raw, Mapping)
        or not isinstance(raw.get("cells"), list | tuple)
        or not isinstance(raw.get("edges"), list | tuple)
    ):
        return None
    cells = tuple(
        cell
        for item in _sequence(raw, "cells")
        if (cell := cell_info_from_raw(item)) is not None
    )
    cell_ids = {cell.id for cell in cells}
    edges = tuple(
        edge
        for item in _sequence(raw, "edges")
        if (edge := _edge_from_raw(item)) is not None
        and edge.source_id in cell_ids
        and edge.target_id in cell_ids
    )
    return NotebookGraph(cells=cells, edges=edges)


def cell_info_from_raw(raw: Any) -> CellInfo | None:
    """Decode one graph cell, dropping invalid wire entries."""

    if not isinstance(raw, Mapping):
        return None
    cell_id = _int_field(raw, "id")
    index = _int_field(raw, "index")
    mode = raw.get("mode")
    if cell_id is None or index is None or not isinstance(mode, str) or not mode:
        return None
    return CellInfo(
        id=cell_id,
        index=index,
        mode=mode,
        key=_optional_string(raw.get("key")),
        name=_optional_string(raw.get("name")),
        defines=_strings(raw, "defines"),
        references=_strings(raw, "references"),
        output=_optional_string(raw.get("output")),
        outputs=_strings(raw, "outputs"),
        runtime_outputs=_strings(raw, "runtime_outputs"),
        autodisplay=raw.get("autodisplay") is True,
        autoview=raw.get("autoview") is True,
        automutable=raw.get("automutable") is True,
        error=_optional_string(raw.get("error")),
    )


def _edge_from_raw(raw: Any) -> DependencyEdge | None:
    if not isinstance(raw, Mapping):
        return None
    source_id = _int_field(raw, "from")
    target_id = _int_field(raw, "to")
    variable = raw.get("variable")
    if (
        source_id is None
        or target_id is None
        or not isinstance(variable, str)
        or not variable
    ):
        return None
    return DependencyEdge(source_id=source_id, target_id=target_id, variable=variable)


def _unique(values: Iterable[str]) -> tuple[str, ...]:
    return tuple(dict.fromkeys(values))


def _sequence(raw: Mapping[str, Any], key: str) -> tuple[Any, ...]:
    value = raw.get(key)
    return tuple(value) if isinstance(value, list | tuple) else ()


def _strings(raw: Mapping[str, Any], key: str) -> tuple[str, ...]:
    return tuple(item for item in _sequence(raw, key) if isinstance(item, str))


def _optional_string(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _int_field(raw: Mapping[str, Any], key: str) -> int | None:
    value = raw.get(key)
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None
