"""Anywidget-independent Observable notebook model and input converters."""

from __future__ import annotations

import dataclasses
import pathlib
from collections.abc import Mapping, Sequence
from typing import Any, cast

from ._cells import Cell, NotebookCellInput, NotebookCellSpec, coerce_cell
from ._files import FileAttachment, FileInput, normalize_files, prepare_source
from ._html import parse_html_cells, parse_html_runtime_profile, parse_html_theme
from ._observable import (
    ObservableDocument,
    ObservableFileInput,
    ObservableFilesInput,
    ObservableNodeInput,
    ObservablePageData,
    fetch_observablehq_document,
    observable_document_import_resolution,
    observable_files_to_attachments,
    observable_nodes_to_cells,
)
from ._serialize import SCRIPT_TYPES, Mode, RuntimeProfile, serialize
from ._themes import Theme, normalize_theme


@dataclasses.dataclass(frozen=True)
class NotebookNode:
    """Notebook Kit-compatible cell data without widget state."""

    id: int
    value: str = ""
    mode: Mode = "ojs"
    key: str | None = None
    name: str | None = None
    pinned: bool = False
    hidden: bool = False
    output: str | None = None
    format: str | None = None
    database: str | None = None
    attrs: Mapping[str, Any] = dataclasses.field(default_factory=dict)

    @classmethod
    def from_cell(cls, cell: Cell, id: int) -> "NotebookNode":
        node = cls.from_spec(cell.to_spec(id))
        return dataclasses.replace(node, key=cell.key)

    @classmethod
    def from_spec(cls, spec: Mapping[str, Any]) -> "NotebookNode":
        attrs = dict(spec)
        node_id = _int_cell_id(attrs.pop("id"))
        value = "" if (raw_value := attrs.pop("value", "")) is None else str(raw_value)
        mode = _mode(attrs.pop("mode", "ojs"))
        name = _optional_str(attrs.pop("name", None))
        key = _optional_str(attrs.pop("key", None)) or name
        return cls(
            id=node_id,
            value=value,
            mode=mode,
            key=key,
            name=name,
            pinned=attrs.pop("pinned", False) is True,
            hidden=attrs.pop("hidden", False) is True,
            output=_optional_str(attrs.pop("output", None)),
            format=_optional_str(attrs.pop("format", None)),
            database=_optional_str(attrs.pop("database", None)),
            attrs=attrs,
        )

    def to_spec(self) -> NotebookCellSpec:
        spec: dict[str, Any] = {
            "id": self.id,
            "value": self.value,
            "mode": self.mode,
        }
        if self.name is not None:
            spec["name"] = self.name
        if self.pinned:
            spec["pinned"] = True
        if self.hidden:
            spec["hidden"] = True
        for key in ("output", "format", "database"):
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
    def cell_names(self) -> tuple[str, ...]:
        return tuple(node.name or "" for node in self.nodes)

    @property
    def cell_keys(self) -> tuple[str, ...]:
        return tuple(node.key or "" for node in self.nodes)

    def to_notebook_html(self) -> str:
        return self.source or serialize(self.spec)


def notebook_model_from_cells(
    cells: Sequence[NotebookCellInput],
    *,
    title: str,
    theme: str | Mapping[str, str],
    files: Mapping[str, FileInput] | None,
    base_path: str | pathlib.Path | None,
) -> NotebookModel:
    normalized_theme = normalize_theme(theme)
    nodes = tuple(
        NotebookNode.from_cell(coerce_cell(item), index)
        for index, item in enumerate(cells, start=1)
    )
    return NotebookModel(
        title=title,
        theme=normalized_theme,
        nodes=_validate_unique_keys(nodes),
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
    cells = parse_html_cells(source)
    nodes = tuple(
        NotebookNode.from_cell(cell, index) for index, cell in enumerate(cells, start=1)
    )
    return NotebookModel(
        theme=parse_html_theme(source),
        nodes=_validate_unique_keys(nodes),
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
    document: ObservableDocument | Mapping[str, Any],
    *,
    title: str | None = None,
    files: Mapping[str, FileInput] | None = None,
) -> NotebookModel:
    if not isinstance(document, Mapping):
        raise TypeError("ObservableHQ document must be a mapping")
    typed_document = cast(ObservableDocument, document)
    return notebook_model_from_observablehq_nodes(
        _document_nodes(typed_document),
        files=_document_files(typed_document),
        title=title or _document_title(typed_document),
        local_files=files,
        import_resolution=observable_document_import_resolution(typed_document),
    )


def notebook_model_from_observablehq_page_data(
    page_data: ObservablePageData | Mapping[str, Any],
    *,
    title: str | None = None,
    files: Mapping[str, FileInput] | None = None,
) -> NotebookModel:
    document = _page_data_document(page_data)
    return notebook_model_from_observablehq_document(
        document,
        title=title,
        files=files,
    )


def notebook_model_from_observablehq_nodes(
    nodes: Sequence[ObservableNodeInput],
    *,
    files: ObservableFilesInput = None,
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
        nodes=_validate_unique_keys(model_nodes),
        source=serialize(spec, runtime_profile="observable"),
        attachments={**discovered, **normalized},
        runtime_profile="observable",
    )


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


def _page_data_document(
    page_data: ObservablePageData | Mapping[str, Any],
) -> ObservableDocument:
    if not isinstance(page_data, Mapping):
        raise TypeError("ObservableHQ page data must be a mapping")
    page_props = page_data.get("pageProps")
    if isinstance(page_props, Mapping):
        initial_notebook = page_props.get("initialNotebook")
        if isinstance(initial_notebook, Mapping):
            return cast(ObservableDocument, initial_notebook)
    initial_notebook = page_data.get("initialNotebook")
    if isinstance(initial_notebook, Mapping):
        return cast(ObservableDocument, initial_notebook)
    raise ValueError("ObservableHQ page data is missing initialNotebook")


def _document_nodes(document: ObservableDocument) -> Sequence[ObservableNodeInput]:
    nodes = document.get("nodes")
    if not isinstance(nodes, Sequence) or isinstance(nodes, (str, bytes, bytearray)):
        raise ValueError("ObservableHQ data is missing a nodes list")
    return nodes


def _document_files(
    document: ObservableDocument,
) -> Sequence[ObservableFileInput] | None:
    files = document.get("files")
    if files is None:
        return None
    if not isinstance(files, Sequence) or isinstance(files, (str, bytes, bytearray)):
        raise ValueError("ObservableHQ files must be a list")
    return files


def _document_title(document: ObservableDocument) -> str:
    title = document.get("title")
    return title if isinstance(title, str) and title else "Untitled"


def _int_cell_id(value: object) -> int:
    if isinstance(value, bool):
        raise ValueError("Notebook cell id must be an integer")
    if isinstance(value, int):
        return value
    raise ValueError("Notebook cell id must be an integer")


def _mode(value: object) -> Mode:
    if not isinstance(value, str) or value not in SCRIPT_TYPES:
        raise ValueError(f"Unsupported Observable cell mode: {value!r}")
    return cast(Mode, value)


def _optional_str(value: object) -> str | None:
    return value if isinstance(value, str) else None
