"""Adapt loaded Observable records into the Python controller model."""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from typing import Any, cast

from ._cell_ids import _CellIdAllocator, _is_safe_cell_id
from ._cells import NotebookCellSpec
from ._files import FileAttachment, normalize_files
from ._model import NotebookModel, NotebookNode, _int_cell_id, _validate_nodes
from ._observable_fetch import unwrap_observable_document
from ._observable_legacy import (
    ObservableFileInput,
    ObservableNodeInput,
    observable_files_to_attachments,
    observable_nodes_to_cells,
)
from ._serialize import RuntimeProfile, serialize
from ._themes import normalize_theme
from .types import FileInput, ObservableDocument


def notebook_model_from_observablehq_document(
    document: ObservableDocument,
    *,
    title: str | None = None,
    files: Mapping[str, FileInput] | None = None,
) -> NotebookModel:
    if not isinstance(document, Mapping):
        raise TypeError("ObservableHQ document must be a mapping")
    document = cast(ObservableDocument, unwrap_observable_document(document))
    body = document.get("body", document)
    if not isinstance(body, Mapping):
        raise TypeError("ObservableHQ notebook body must be a mapping")
    body = cast(Mapping[str, Any], body)
    if ("nodes" in body) == ("cells" in body):
        raise ValueError("ObservableHQ document must contain either nodes or cells")
    resolutions = _observable_resolutions(document.get("resolutions", []))
    if any(record["type"] == "unsupported_mode" for record in resolutions):
        raise ValueError(
            "ObservableHQ document has lost its original cell languages. "
            "Use from_observablehq() to fetch the original notebook source."
        )
    classic = "nodes" in body
    library_version = body.get(
        "stdlib",
        next(
            (record["value"] for record in resolutions if record["type"] == "stdlib"),
            "1" if classic else "2",
        ),
    )
    if library_version not in {"1", "2"}:
        raise ValueError(
            f"Unsupported Observable standard library: {library_version!r}"
        )
    profile: RuntimeProfile = "observable" if library_version == "1" else "notebook-kit"
    if classic:
        cells = observable_nodes_to_cells(
            _document_nodes(cast(ObservableDocument, body))
        )
        discovered = observable_files_to_attachments(
            _document_files(cast(ObservableDocument, body))
        )
    else:
        cells = _native_cells(body.get("cells"))
        discovered = _native_attachments(body.get("files", []))
    resolved_title = title or body.get("title") or document.get("title") or "Untitled"
    if not isinstance(resolved_title, str):
        raise TypeError("Observable notebook title must be a string")
    theme = normalize_theme(body.get("theme", "air"))
    spec = {"title": resolved_title, "theme": theme, "cells": cells}
    origin = {
        "format": "classic" if classic else "notebook-kit",
        "id": document.get("id"),
        "version": document.get("version"),
        "resolutions": {
            record["specifier"]: record["value"]
            for record in resolutions
            if record["type"] == "notebook"
        },
    }
    return NotebookModel(
        title=resolved_title,
        theme=theme,
        nodes=_validate_nodes(tuple(NotebookNode.from_spec(cell) for cell in cells)),
        source=serialize(spec, runtime_profile=profile, origin=origin),
        attachments={**discovered, **normalize_files(files, base_path=None)},
        runtime_profile=profile,
    )


def _native_cells(value: object) -> list[NotebookCellSpec]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        raise TypeError("Observable notebook cells must be a sequence")
    cells: list[NotebookCellSpec] = []
    records: list[dict[str, Any]] = []
    reserved: set[int] = set()
    seen: set[int] = set()
    for cell in value:
        if not isinstance(cell, Mapping):
            raise TypeError("Observable notebook cell must be an object")
        record = dict(cell)
        for key in ("pinned", "hidden"):
            if key in record and not isinstance(record[key], bool):
                raise TypeError(f"Observable notebook cell {key} must be a boolean")
        cell_id = record.get("id")
        if cell_id != 0 or isinstance(cell_id, bool):
            cell_id = _int_cell_id(cell_id)
            reserved.add(cell_id)
        else:
            cell_id = 0
        if cell_id in seen:
            raise ValueError(f"Observable notebook cell ids must be unique: {cell_id}")
        seen.add(cell_id)
        if "value" in record and not isinstance(record["value"], str):
            raise TypeError("Observable notebook cell value must be a string")
        records.append(record)
    allocator = _CellIdAllocator(reserved)
    for cell in records:
        spec = {
            key: cell[key]
            for key in (
                "value",
                "mode",
                "pinned",
                "hidden",
                "output",
                "database",
                "format",
                "since",
            )
            if cell.get(key) is not None
        }
        cell_id = cell.get("id")
        if cell_id == 0 and not isinstance(cell_id, bool):
            cell_id = allocator.allocate()
        if not _is_safe_cell_id(cell_id):
            raise ValueError(
                "Observable notebook cell id must be a nonnegative safe integer"
            )
        spec["id"] = cell_id
        spec.setdefault("mode", "js")
        spec.setdefault("pinned", False)
        if spec.get("output") == "":
            del spec["output"]
        cells.append(cast(NotebookCellSpec, spec))
    return cells


def _observable_resolutions(value: object) -> list[dict[str, str]]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        raise TypeError("Observable notebook resolutions must be a sequence")
    resolutions: list[dict[str, str]] = []
    for raw in value:
        if not isinstance(raw, Mapping):
            raise TypeError("Observable notebook resolution must be an object")
        resolution = dict(raw)
        if not all(
            isinstance(resolution.get(key), str)
            for key in ("type", "specifier", "value")
        ):
            raise TypeError(
                "Observable notebook resolution type, specifier, and value must be strings"
            )
        resolutions.append(
            {
                "type": cast(str, resolution["type"]),
                "specifier": cast(str, resolution["specifier"]),
                "value": cast(str, resolution["value"]),
            }
        )
    return resolutions


def _native_attachments(value: object) -> dict[str, FileAttachment]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        raise TypeError("Observable notebook files must be a sequence")
    attachments: dict[str, FileAttachment] = {}
    for raw in value:
        if not isinstance(raw, Mapping):
            raise TypeError("Observable notebook file must be an object")
        file = dict(raw)
        name = file.get("name")
        url = file.get("href")
        mime_type = file.get("type", "application/octet-stream")
        if not isinstance(name, str) or not name:
            raise TypeError("Observable notebook file name must be a nonempty string")
        if not isinstance(url, str):
            raise TypeError(f"Observable notebook file {name!r} href must be a string")
        if not isinstance(mime_type, str):
            raise TypeError(f"Observable notebook file {name!r} type must be a string")
        info: FileAttachment = {"url": url, "mimeType": mime_type}
        if "size" in file:
            size = file["size"]
            if not isinstance(size, int) or isinstance(size, bool) or size < 0:
                raise TypeError(
                    f"Observable notebook file {name!r} size must be a nonnegative integer"
                )
            info["size"] = size
        if "lastModified" in file:
            last_modified = file["lastModified"]
            if (
                not isinstance(last_modified, int | float)
                or isinstance(last_modified, bool)
                or not math.isfinite(last_modified)
                or last_modified < 0
            ):
                raise TypeError(
                    f"Observable notebook file {name!r} lastModified must be a nonnegative finite number"
                )
            info["lastModified"] = int(last_modified)
        attachments[name] = info
    return attachments


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
