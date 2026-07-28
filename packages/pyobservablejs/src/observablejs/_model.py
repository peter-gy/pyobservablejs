"""Anywidget-independent Observable notebook model and input converters."""

from __future__ import annotations

import dataclasses
import pathlib
from collections.abc import Iterable, Mapping, Sequence
from typing import Any, cast

from ._cell_ids import _MAX_SAFE_CELL_ID, _CellIdAllocator, _is_safe_cell_id
from ._cells import (
    Cell,
    NotebookCellInput,
    NotebookCellSpec,
    coerce_cell,
)
from ._files import FileAttachment, normalize_files, prepare_source
from ._html import parse_html_cells, parse_html_runtime_profile, parse_html_theme
from ._observable import (
    ObservableFileInput,
    ObservableNodeInput,
    fetch_observablehq_document,
    observable_document_import_resolution,
    observable_files_to_attachments,
    observable_nodes_to_cells,
)
from ._serialize import SCRIPT_TYPES, Mode, RuntimeProfile, serialize
from ._themes import normalize_theme
from .types import FileInput, ObservableDocument, Theme


@dataclasses.dataclass(frozen=True)
class NotebookNode:
    """Notebook Kit-compatible cell data without widget state."""

    id: int
    value: str = ""
    mode: Mode = "ojs"
    key: str | None = None
    pinned: bool = False
    hidden: bool = False
    output: str | None = None
    format: str | None = None
    database: str | None = None
    since: str | int | float | None = None
    attrs: Mapping[str, Any] = dataclasses.field(default_factory=dict)

    @classmethod
    def from_cell(cls, cell: Cell, id: int) -> NotebookNode:
        node = cls.from_spec(cell._to_spec(id))
        return dataclasses.replace(node, key=cell.key)

    @classmethod
    def from_spec(cls, spec: Mapping[str, Any]) -> NotebookNode:
        attrs = dict(spec)
        node_id = _int_cell_id(attrs.pop("id"))
        value = "" if (raw_value := attrs.pop("value", "")) is None else str(raw_value)
        mode = _mode(attrs.pop("mode", "ojs"))
        key = _optional_str(attrs.pop("key", None))
        if "name" in attrs:
            raise ValueError("Notebook cell specs use key for public identity")
        return cls(
            id=node_id,
            value=value,
            mode=mode,
            key=key,
            pinned=attrs.pop("pinned", False) is True,
            hidden=attrs.pop("hidden", False) is True,
            output=_optional_str(attrs.pop("output", None)),
            format=_optional_str(attrs.pop("format", None)),
            database=_optional_str(attrs.pop("database", None)),
            since=_since(attrs.pop("since", None)),
            attrs=attrs,
        )

    def to_spec(self) -> NotebookCellSpec:
        spec: dict[str, Any] = {
            "id": self.id,
            "value": self.value,
            "mode": self.mode,
        }
        if self.key is not None:
            spec["key"] = self.key
        if self.pinned:
            spec["pinned"] = True
        if self.hidden:
            spec["hidden"] = True
        for key in ("output", "format", "database", "since"):
            value = getattr(self, key)
            if value is not None:
                spec[key] = value
        for key, value in self.attrs.items():
            if value is not None:
                spec[key] = value
        return cast(NotebookCellSpec, spec)


@dataclasses.dataclass(frozen=True)
class NotebookModel:
    """Prepared notebook data consumed by the widget layer."""

    title: str = "Untitled"
    theme: Theme = "air"
    nodes: tuple[NotebookNode, ...] = ()
    source: str = ""
    attachments: Mapping[str, FileAttachment] = dataclasses.field(default_factory=dict)
    runtime_profile: RuntimeProfile = "notebook-kit"

    @property
    def spec(self) -> dict[str, Any]:
        if self.source:
            return {}
        return {
            "title": self.title,
            "theme": self.theme,
            "cells": [node.to_spec() for node in self.nodes],
        }

    @property
    def cell_keys(self) -> tuple[str, ...]:
        return tuple(node.key or "" for node in self.nodes)

    def to_notebook_html(self) -> str:
        return self.source or serialize(self.spec)


def notebook_model_from_cells(
    cells: Sequence[NotebookCellInput],
    *,
    title: str,
    theme: Theme,
    files: Mapping[str, FileInput] | None,
    base_path: str | pathlib.Path | None,
) -> NotebookModel:
    normalized_theme = normalize_theme(theme)
    nodes = _nodes_from_cells(tuple(coerce_cell(item) for item in cells))
    return NotebookModel(
        title=title,
        theme=normalized_theme,
        nodes=_validate_nodes(nodes),
        attachments=normalize_files(files, base_path=base_path),
    )


def notebook_model_from_html(
    source: str,
    *,
    files: Mapping[str, FileInput] | None,
    base_path: str | pathlib.Path | None,
    embed_file_attachments: bool,
    rewrite_imports: bool,
) -> NotebookModel:
    if not isinstance(source, str):
        raise TypeError("source must be a Notebook Kit HTML string")
    source, discovered = prepare_source(
        source,
        base_path=base_path,
        embed=embed_file_attachments,
        rewrite_imports=rewrite_imports,
    )
    normalized = normalize_files(files, base_path=base_path)
    nodes = _nodes_from_cells(parse_html_cells(source))
    return NotebookModel(
        theme=parse_html_theme(source),
        nodes=_validate_nodes(nodes),
        source=source,
        attachments={**discovered, **normalized},
        runtime_profile=parse_html_runtime_profile(source),
    )


def notebook_model_from_observablehq(
    specifier: str,
    *,
    files: Mapping[str, FileInput] | None,
    timeout: float | None,
) -> NotebookModel:
    document = fetch_observablehq_document(specifier, timeout=timeout)
    return notebook_model_from_observablehq_document(
        document,
        files=files,
    )


def notebook_model_from_observablehq_document(
    document: ObservableDocument,
    *,
    title: str | None = None,
    files: Mapping[str, FileInput] | None = None,
) -> NotebookModel:
    if not isinstance(document, Mapping):
        raise TypeError("ObservableHQ document must be a mapping")
    return _notebook_model_from_observable_document_parts(
        _document_nodes(document),
        files=_document_files(document),
        title=title or _document_title(document),
        local_files=files,
        import_resolution=observable_document_import_resolution(document),
    )


def _notebook_model_from_observable_document_parts(
    nodes: Sequence[ObservableNodeInput],
    *,
    files: Sequence[ObservableFileInput] | None = None,
    title: str = "Untitled",
    local_files: Mapping[str, FileInput] | None = None,
    import_resolution: str | None = None,
) -> NotebookModel:
    if not isinstance(nodes, Sequence) or isinstance(nodes, (str, bytes, bytearray)):
        raise TypeError("ObservableHQ nodes must be a sequence of node mappings")
    cells = observable_nodes_to_cells(nodes, import_resolution=import_resolution)
    spec = {"title": title, "theme": "air", "cells": cells}
    discovered = observable_files_to_attachments(files)
    normalized = normalize_files(local_files, base_path=None)
    model_nodes = tuple(NotebookNode.from_spec(cell) for cell in cells)
    return NotebookModel(
        title=title,
        theme="air",
        nodes=_validate_nodes(model_nodes),
        source=serialize(spec, runtime_profile="observable"),
        attachments={**discovered, **normalized},
        runtime_profile="observable",
    )


def _nodes_from_cells(cells: Sequence[Cell]) -> tuple[NotebookNode, ...]:
    explicit_ids = [cell.id for cell in cells if cell.id is not None]
    duplicates = _duplicates(explicit_ids)
    if duplicates:
        ids = ", ".join(str(cell_id) for cell_id in sorted(duplicates))
        raise ValueError(f"Notebook cell ids must be unique: {ids}")

    allocator = _CellIdAllocator(set(explicit_ids))
    nodes: list[NotebookNode] = []
    for cell in cells:
        if cell.id is None:
            cell_id = allocator.allocate()
        else:
            cell_id = cell.id
            allocator.advance_past(cell_id)
        nodes.append(NotebookNode.from_cell(cell, cell_id))
    return tuple(nodes)


def _validate_nodes(nodes: tuple[NotebookNode, ...]) -> tuple[NotebookNode, ...]:
    invalid_ids = {node.id for node in nodes if not _is_safe_cell_id(node.id)}
    if invalid_ids:
        ids = ", ".join(str(cell_id) for cell_id in sorted(invalid_ids))
        raise ValueError(
            f"Notebook cell ids must be between 1 and {_MAX_SAFE_CELL_ID}: {ids}"
        )
    duplicate_ids = _duplicates(node.id for node in nodes)
    if duplicate_ids:
        ids = ", ".join(str(cell_id) for cell_id in sorted(duplicate_ids))
        raise ValueError(f"Notebook cell ids must be unique: {ids}")
    return _validate_unique_keys(nodes)


def _validate_unique_keys(nodes: tuple[NotebookNode, ...]) -> tuple[NotebookNode, ...]:
    seen: dict[str, int] = {}
    duplicates: set[str] = set()
    for node in nodes:
        if not node.key:
            continue
        if node.key in seen:
            duplicates.add(node.key)
        seen[node.key] = node.id
    if duplicates:
        names = ", ".join(sorted(repr(name) for name in duplicates))
        raise ValueError(f"Observable cell keys must be unique: {names}")
    return nodes


def _duplicates(values: Iterable[int]) -> set[int]:
    seen: set[int] = set()
    duplicates: set[int] = set()
    for value in values:
        if value in seen:
            duplicates.add(value)
        seen.add(value)
    return duplicates


def _document_nodes(document: ObservableDocument) -> Sequence[ObservableNodeInput]:
    nodes = document.get("nodes")
    if nodes is None:
        raise ValueError("ObservableHQ data is missing a nodes list")
    if not isinstance(nodes, Sequence) or isinstance(nodes, (str, bytes, bytearray)):
        raise TypeError("ObservableHQ nodes must be a list")
    return nodes


def _document_files(
    document: ObservableDocument,
) -> Sequence[ObservableFileInput] | None:
    files = document.get("files")
    if files is None:
        return None
    if not isinstance(files, Sequence) or isinstance(files, (str, bytes, bytearray)):
        raise TypeError("ObservableHQ files must be a list")
    return files


def _document_title(document: ObservableDocument) -> str:
    title = document.get("title")
    return title if isinstance(title, str) and title else "Untitled"


def _int_cell_id(value: object) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise TypeError("Notebook cell id must be an integer")
    if not _is_safe_cell_id(value):
        raise ValueError(f"Notebook cell id must be between 1 and {_MAX_SAFE_CELL_ID}")
    return value


def _mode(value: object) -> Mode:
    if not isinstance(value, str) or value not in SCRIPT_TYPES:
        raise ValueError(f"Unsupported Observable cell mode: {value!r}")
    return cast(Mode, value)


def _optional_str(value: object) -> str | None:
    return value if isinstance(value, str) else None


def _since(value: object) -> str | int | float | None:
    if isinstance(value, bool):
        return None
    return value if isinstance(value, str | int | float) else None
