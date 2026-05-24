"""Python view of Notebook Kit-derived symbolic graph metadata."""

from __future__ import annotations

import dataclasses
from collections.abc import Iterable, Mapping
from typing import Any


@dataclasses.dataclass(frozen=True)
class DependencyEdge:
    """A symbolic dependency between two notebook cell ids."""

    source_id: int
    target_id: int
    name: str


@dataclasses.dataclass(frozen=True)
class CellInfo:
    """Notebook Kit-derived symbolic information for one cell."""

    id: int
    index: int
    mode: str
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

    @property
    def inputs(self) -> tuple[str, ...]:
        return self.references

    @property
    def visible_variables(self) -> tuple[str, ...]:
        return self.defines


@dataclasses.dataclass(frozen=True)
class NotebookGraph:
    """Browser-produced symbolic graph for an Observable notebook."""

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


def graph_from_raw(raw: Any) -> NotebookGraph | None:
    """Decode the synced graph trait into immutable public objects."""

    if not isinstance(raw, Mapping):
        return None
    if not raw:
        return None
    cells = tuple(
        cell
        for item in _sequence(raw, "cells")
        if (cell := cell_info_from_raw(item)) is not None
    )
    edges = tuple(
        edge
        for item in _sequence(raw, "edges")
        if (edge := _edge_from_raw(item)) is not None
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
    name = raw.get("name")
    if source_id is None or target_id is None or not isinstance(name, str) or not name:
        return None
    return DependencyEdge(source_id=source_id, target_id=target_id, name=name)


def _unique(values: Iterable[str]) -> tuple[str, ...]:
    return tuple(dict.fromkeys(values))


def _sequence(raw: Mapping[str, Any], key: str) -> tuple[Any, ...]:
    value = raw.get(key)
    return value if isinstance(value, list | tuple) else ()


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
