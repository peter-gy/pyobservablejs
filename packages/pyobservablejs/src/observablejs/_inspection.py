"""Structured notebook inspection and data read results."""

from __future__ import annotations

import dataclasses
import math
from collections.abc import Mapping, Sequence
from typing import TYPE_CHECKING, Any, Literal, cast

from ._graph import CellInfo, NotebookGraph, cell_info_from_raw, graph_from_raw

if TYPE_CHECKING:
    from ._notebook import Notebook, NotebookCell
    from .types import ThemeSnapshot

ReadFormat = Literal["rows", "arrow", "json", "bytes"]
DatasetKind = Literal["arrow", "arquero", "rows", "array"]


@dataclasses.dataclass(frozen=True)
class ColumnInfo:
    """One dataset column and its native or inferred type."""

    name: str
    type: str
    nullable: bool | None


@dataclasses.dataclass(frozen=True)
class DatasetDescription:
    """Dataset shape observed without materializing additional values."""

    kind: DatasetKind
    row_count: int
    columns: tuple[ColumnInfo, ...]
    schema_source: Literal["native", "sampled"]
    sampled_rows: int


@dataclasses.dataclass(frozen=True)
class DatasetInfo(DatasetDescription):
    """A materialized dataset at one view generation and value revision."""

    cell: NotebookCell
    name: str | None
    revision: int
    generation: str
    _owner: object | None = dataclasses.field(
        default=None, init=False, repr=False, compare=False
    )


@dataclasses.dataclass(frozen=True)
class NotebookRead:
    """An explicit read containing binary bytes or detached Python values."""

    cell: NotebookCell | None
    name: str | None
    revision: int
    format: ReadFormat
    data: object
    dataset: DatasetDescription | None = None
    mime_type: str | None = None

    def to_arrow(self) -> Any:
        """Decode Arrow IPC bytes with the optional ``pyarrow`` package."""

        if self.format != "arrow" or not isinstance(self.data, bytes):
            raise ValueError("to_arrow() requires an Arrow read")
        try:
            from pyarrow import ipc
        except ImportError as error:
            raise ImportError("Install pyarrow to decode Arrow reads") from error
        return ipc.open_stream(self.data).read_all()


@dataclasses.dataclass(frozen=True, kw_only=True)
class CellInspection(CellInfo):
    """Prepared source and static references for one notebook cell."""

    cell: NotebookCell
    source: str
    pinned: bool
    hidden: bool
    files: tuple[str, ...]
    databases: tuple[str, ...]
    secrets: tuple[str, ...]


@dataclasses.dataclass(frozen=True)
class ImportBinding:
    """An imported symbol and the local name bound to it."""

    imported: str
    local: str


@dataclasses.dataclass(frozen=True)
class ImportInfo:
    """A static or dynamic import discovered in a notebook cell."""

    cell: NotebookCell
    kind: Literal["static", "dynamic"]
    source: str | None
    resolved: str | None
    bindings: tuple[ImportBinding, ...]
    injections: tuple[ImportBinding, ...]


@dataclasses.dataclass(frozen=True)
class AttachmentInspection:
    """Declared attachment metadata and cells that reference the file."""

    name: str
    url: str | None
    cells: tuple[NotebookCell, ...]
    mime_type: str | None = None
    size: int | None = None
    last_modified: int | float | None = None


@dataclasses.dataclass(frozen=True)
class NotebookInspection:
    """Full definition metadata produced by the TypeScript analyzer."""

    title: str
    theme: ThemeSnapshot
    runtime_profile: Literal["notebook-kit", "observable"]
    cells: tuple[CellInspection, ...]
    graph: NotebookGraph
    attachments: tuple[AttachmentInspection, ...]
    imports: tuple[ImportInfo, ...]


def _object(
    value: object, required: set[str], optional: set[str] | frozenset[str] = frozenset()
) -> Mapping[str, Any]:
    if (
        not isinstance(value, Mapping)
        or not required <= set(value)
        or set(value) - required - optional
    ):
        raise ValueError("Notebook response has an invalid object shape")
    return cast(Mapping[str, Any], value)


def _string(value: object, *, nullable: bool = False) -> str | None:
    if isinstance(value, str) or (nullable and value is None):
        return value
    raise ValueError("Notebook response requires a string")


def _integer(value: object) -> int:
    if type(value) is not int or not 0 <= value <= (1 << 53) - 1:
        raise ValueError("Notebook response requires a non-negative safe integer")
    return value


def _number(value: object) -> int | float:
    if (
        isinstance(value, bool)
        or not isinstance(value, int | float)
        or not math.isfinite(value)
    ):
        raise ValueError("Notebook response requires a finite number")
    return value


def _sequence(value: object) -> Sequence[Any]:
    if not isinstance(value, list | tuple):
        raise TypeError("Notebook response requires a list")
    return value


def _strings(value: object) -> tuple[str, ...]:
    return tuple(cast(str, _string(item)) for item in _sequence(value))


def _cell(notebook: Notebook, value: object) -> NotebookCell:
    index = _integer(value)
    if index >= len(notebook._nodes):
        raise ValueError("Notebook response references an unknown cell")
    return notebook._cell_at(index)


_DATASET_FIELDS = {"kind", "rowCount", "columns", "schemaSource", "sampledRows"}


def _dataset(value: object) -> DatasetDescription:
    raw = _object(value, _DATASET_FIELDS)
    if raw["kind"] not in {"arrow", "arquero", "rows", "array"} or raw[
        "schemaSource"
    ] not in {"native", "sampled"}:
        raise ValueError(
            "Notebook response has an invalid dataset kind or schema source"
        )
    columns: list[ColumnInfo] = []
    for item in _sequence(raw["columns"]):
        column = _object(item, {"name", "type", "nullable"})
        if column["nullable"] is not None and type(column["nullable"]) is not bool:
            raise ValueError("Column nullable must be a boolean or None")
        columns.append(
            ColumnInfo(
                cast(str, _string(column["name"])),
                cast(str, _string(column["type"])),
                column["nullable"],
            )
        )
    return DatasetDescription(
        raw["kind"],
        _integer(raw["rowCount"]),
        tuple(columns),
        raw["schemaSource"],
        _integer(raw["sampledRows"]),
    )


def decode_datasets(
    value: object, notebook: Notebook, generation: str, owner: object
) -> tuple[DatasetInfo, ...]:
    result: list[DatasetInfo] = []
    for item in _sequence(value):
        raw = _object(item, _DATASET_FIELDS | {"cell", "name", "revision"})
        description = _dataset({key: raw[key] for key in _DATASET_FIELDS})
        info = DatasetInfo(
            **{
                field.name: getattr(description, field.name)
                for field in dataclasses.fields(description)
            },
            cell=_cell(notebook, raw["cell"]),
            name=_string(raw["name"], nullable=True),
            revision=_integer(raw["revision"]),
            generation=generation,
        )
        object.__setattr__(info, "_owner", owner)
        result.append(info)
    return tuple(result)


def decode_read(
    value: object, notebook: Notebook, buffers: Sequence[bytes]
) -> NotebookRead:
    from ._variables import deserialize_value, freeze_value

    raw = _object(
        value,
        {"cell", "name", "revision", "format"},
        {"data", "dataset", "mimeType", "binary"},
    )
    if raw["format"] not in {"rows", "arrow", "json", "bytes"}:
        raise ValueError("Notebook response has an invalid read format")
    if raw.get("binary") is True:
        if (
            len(buffers) != 1
            or "data" in raw
            or raw["format"] not in {"arrow", "bytes"}
        ):
            raise ValueError("Binary reads require one buffer")
        data: object = buffers[0]
    else:
        if "data" not in raw or buffers or raw["format"] in {"arrow", "bytes"}:
            raise ValueError("Notebook read has an invalid payload")
        data = freeze_value(deserialize_value(raw["data"]))
    return NotebookRead(
        cell=None if raw["cell"] is None else _cell(notebook, raw["cell"]),
        name=_string(raw["name"], nullable=True),
        revision=_integer(raw["revision"]),
        format=raw["format"],
        data=data,
        dataset=_dataset(raw["dataset"]) if "dataset" in raw else None,
        mime_type=_string(raw.get("mimeType"), nullable=True),
    )


def decode_inspection(value: object, notebook: Notebook) -> NotebookInspection:
    from ._readback import _validate_graph_wire
    from ._themes import normalize_theme
    from ._variables import freeze_value

    raw = _object(
        value,
        {
            "title",
            "theme",
            "runtimeProfile",
            "cells",
            "graph",
            "attachments",
            "imports",
        },
    )
    profile = raw["runtimeProfile"]
    if profile not in {"notebook-kit", "observable"}:
        raise ValueError("Notebook response has an invalid runtime profile")
    graph_raw = _object(raw["graph"], {"cells", "edges"})
    graph_cells = []
    for item in _sequence(graph_raw["cells"]):
        cell = dict(cast(Mapping[str, Any], item))
        cell["runtime_outputs"] = cell.pop("runtimeOutputs")
        graph_cells.append(cell)
    graph_wire = _validate_graph_wire(
        {"cells": graph_cells, "edges": graph_raw["edges"]}
    )
    graph = graph_from_raw(graph_wire)
    if graph is None:
        raise ValueError("Notebook response has an invalid graph")
    graph_fields = {field.name for field in dataclasses.fields(CellInfo)} - {"error"}
    graph_fields.remove("runtime_outputs")
    graph_fields.add("runtimeOutputs")
    extra = {"source", "pinned", "hidden", "files", "databases", "secrets"}
    cells: list[CellInspection] = []
    for item in _sequence(raw["cells"]):
        cell_raw = _object(item, graph_fields | extra, {"error"})
        wire = {key: cell_raw[key] for key in graph_fields if key != "runtimeOutputs"}
        wire["runtime_outputs"] = cell_raw["runtimeOutputs"]
        if "error" in cell_raw:
            wire["error"] = cell_raw["error"]
        _validate_graph_wire({"cells": [wire], "edges": []})
        info = cell_info_from_raw(wire)
        if (
            info is None
            or type(cell_raw["pinned"]) is not bool
            or type(cell_raw["hidden"]) is not bool
        ):
            raise ValueError("Notebook response has invalid cell metadata")
        cells.append(
            CellInspection(
                **{
                    field.name: getattr(info, field.name)
                    for field in dataclasses.fields(info)
                },
                cell=_cell(notebook, info.index),
                source=cast(str, _string(cell_raw["source"])),
                pinned=cell_raw["pinned"],
                hidden=cell_raw["hidden"],
                files=_strings(cell_raw["files"]),
                databases=_strings(cell_raw["databases"]),
                secrets=_strings(cell_raw["secrets"]),
            )
        )
    attachments: list[AttachmentInspection] = []
    for item in _sequence(raw["attachments"]):
        attachment = _object(
            item, {"name", "url", "cells"}, {"mimeType", "size", "lastModified"}
        )
        attachments.append(
            AttachmentInspection(
                name=cast(str, _string(attachment["name"])),
                url=_string(attachment["url"], nullable=True),
                cells=tuple(
                    _cell(notebook, index) for index in _sequence(attachment["cells"])
                ),
                mime_type=_string(attachment.get("mimeType"), nullable=True),
                size=_integer(attachment["size"]) if "size" in attachment else None,
                last_modified=_number(attachment["lastModified"])
                if "lastModified" in attachment
                else None,
            )
        )
    imports: list[ImportInfo] = []
    for item in _sequence(raw["imports"]):
        imported = _object(
            item, {"cell", "kind", "source", "resolved", "bindings", "injections"}
        )
        if imported["kind"] not in {"static", "dynamic"}:
            raise ValueError("Notebook response has an invalid import kind")
        bindings: dict[str, tuple[ImportBinding, ...]] = {}
        for key in ("bindings", "injections"):
            entries = []
            for item in _sequence(imported[key]):
                binding = _object(item, {"imported", "local"})
                entries.append(
                    ImportBinding(
                        cast(str, _string(binding["imported"])),
                        cast(str, _string(binding["local"])),
                    )
                )
            bindings[key] = tuple(entries)
        imports.append(
            ImportInfo(
                _cell(notebook, imported["cell"]),
                imported["kind"],
                _string(imported["source"], nullable=True),
                _string(imported["resolved"], nullable=True),
                bindings["bindings"],
                bindings["injections"],
            )
        )
    return NotebookInspection(
        cast(str, _string(raw["title"])),
        freeze_value(normalize_theme(raw["theme"])),
        profile,
        tuple(cells),
        graph,
        tuple(attachments),
        tuple(imports),
    )
