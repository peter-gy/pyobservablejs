"""Validate browser readback before publishing a view snapshot."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, cast

import traitlets

from . import errors
from ._variables import deserialize_value
from .types import CellError, ErrorPhase, ViewError

_MAX_SAFE_REVISION = (1 << 53) - 1


def validate_readback_wire(
    value: object, selected_indexes: Sequence[int]
) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise traitlets.TraitError("_readback must be a mapping")
    value = cast(Mapping[str, object], value)
    required = {
        "revision",
        "input_revision",
        "settled_revision",
        "pending",
        "graph",
        "results",
        "errors",
    }
    if set(value) != required:
        raise traitlets.TraitError("_readback has an invalid field set")
    revision = _wire_revision(value["revision"], "revision")
    input_revision = _optional_wire_revision(value["input_revision"], "input_revision")
    settled_revision = _optional_wire_revision(
        value["settled_revision"], "settled_revision"
    )
    pending = value["pending"]
    raw_graph = value["graph"]
    raw_results = value["results"]
    raw_errors = value["errors"]
    if not isinstance(pending, bool):
        raise traitlets.TraitError("_readback pending must be a boolean")
    if not isinstance(raw_graph, Mapping):
        raise traitlets.TraitError("_readback graph must be a mapping")
    if not isinstance(raw_results, Mapping):
        raise traitlets.TraitError("_readback results must be a mapping")
    if not isinstance(raw_errors, list | tuple):
        raise traitlets.TraitError("_readback errors must be a list")
    if input_revision is None:
        if settled_revision is not None or pending or raw_results:
            raise traitlets.TraitError("idle readback state is inconsistent")
    else:
        if settled_revision is not None and settled_revision > input_revision:
            raise traitlets.TraitError("settled_revision cannot exceed input_revision")
        if pending and settled_revision == input_revision:
            raise traitlets.TraitError("pending readback cannot be settled")
        if not pending and settled_revision != input_revision:
            raise traitlets.TraitError("non-pending readback must be settled")
    selected = {str(index) for index in selected_indexes}
    results: dict[str, Any] = {}
    pending_results = 0
    for raw_index, raw_result in raw_results.items():
        if not isinstance(raw_index, str) or raw_index not in selected:
            raise traitlets.TraitError(
                "readback result keys must be selected cell indexes"
            )
        result = _validate_result_wire(raw_result, input_revision)
        if result["status"] == "pending":
            pending_results += 1
        results[raw_index] = result
    if input_revision is not None and set(results) != selected and not raw_errors:
        raise traitlets.TraitError(
            "evaluating readback must contain every selected cell"
        )
    if pending != (pending_results > 0):
        raise traitlets.TraitError("readback pending state does not match results")
    errors = [_validate_error_wire(item, cell=False) for item in raw_errors]
    graph = _validate_graph_wire(raw_graph)
    return {
        "revision": revision,
        "input_revision": input_revision,
        "settled_revision": settled_revision,
        "pending": pending,
        "graph": dict(graph),
        "results": results,
        "errors": errors,
    }


def _validate_graph_wire(value: Mapping[Any, Any]) -> dict[str, Any]:
    if not value:
        return {}
    if set(value) != {"cells", "edges"}:
        raise traitlets.TraitError("_readback graph has an invalid field set")
    raw_cells = value["cells"]
    raw_edges = value["edges"]
    if not isinstance(raw_cells, list | tuple) or not isinstance(
        raw_edges, list | tuple
    ):
        raise traitlets.TraitError("_readback graph cells and edges must be lists")

    required_cell_fields = {
        "id",
        "index",
        "key",
        "mode",
        "defines",
        "references",
        "output",
        "outputs",
        "runtime_outputs",
        "autodisplay",
        "autoview",
        "automutable",
    }
    cells: list[dict[str, Any]] = []
    ids: set[int] = set()
    indexes: set[int] = set()
    for item in raw_cells:
        if not isinstance(item, Mapping):
            raise traitlets.TraitError("graph cells must be mappings")
        item = cast(Mapping[Any, Any], item)
        fields = set(item)
        if (
            fields - (required_cell_fields | {"error"})
            or not required_cell_fields <= fields
        ):
            raise traitlets.TraitError("graph cell has an invalid shape")
        cell_id = _wire_revision(item["id"], "graph cell id")
        index = _wire_revision(item["index"], "graph cell index")
        key = item["key"]
        mode = item["mode"]
        output = item["output"]
        error = item.get("error")
        if cell_id == 0:
            raise traitlets.TraitError("graph cell id must be positive")
        if cell_id in ids or index in indexes:
            raise traitlets.TraitError("graph cell ids and indexes must be unique")
        if not isinstance(key, str) or not isinstance(mode, str) or not mode:
            raise traitlets.TraitError("graph cell key and mode must be strings")
        if output is not None and not isinstance(output, str):
            raise traitlets.TraitError("graph cell output must be a string or null")
        if error is not None and not isinstance(error, str):
            raise traitlets.TraitError("graph cell error must be a string")
        sequences = {
            field: _validate_string_sequence(item[field], f"graph cell {field}")
            for field in ("defines", "references", "outputs", "runtime_outputs")
        }
        flags = {}
        for field in ("autodisplay", "autoview", "automutable"):
            flag = item[field]
            if not isinstance(flag, bool):
                raise traitlets.TraitError(f"graph cell {field} must be a boolean")
            flags[field] = flag
        ids.add(cell_id)
        indexes.add(index)
        cells.append(
            {
                "id": cell_id,
                "index": index,
                "key": key,
                "mode": mode,
                **sequences,
                "output": output,
                **flags,
                **({"error": error} if error is not None else {}),
            }
        )

    edges: list[dict[str, Any]] = []
    for item in raw_edges:
        if not isinstance(item, Mapping) or set(item) != {
            "from",
            "to",
            "variable",
        }:
            raise traitlets.TraitError("graph edge has an invalid shape")
        item = cast(Mapping[Any, Any], item)
        source = _wire_revision(item["from"], "graph edge source")
        target = _wire_revision(item["to"], "graph edge target")
        variable = item["variable"]
        if source not in ids or target not in ids:
            raise traitlets.TraitError("graph edge must reference known cells")
        if not isinstance(variable, str) or not variable:
            raise traitlets.TraitError("graph edge variable must be a non-empty string")
        edges.append({"from": source, "to": target, "variable": variable})
    return {"cells": cells, "edges": edges}


def _validate_string_sequence(value: object, field: str) -> list[str]:
    if not isinstance(value, list | tuple) or any(
        not isinstance(item, str) for item in value
    ):
        raise traitlets.TraitError(f"{field} must be a list of strings")
    return cast(list[str], list(value))


def _validate_result_wire(value: object, input_revision: int | None) -> dict[str, Any]:
    if not isinstance(value, Mapping) or set(value) != {
        "revision",
        "status",
        "values",
        "errors",
    }:
        raise traitlets.TraitError("cell result has an invalid shape")
    value = cast(Mapping[str, object], value)
    revision = _wire_revision(value["revision"], "cell result revision")
    if input_revision is None or revision > input_revision:
        raise traitlets.TraitError("cell result revision is newer than the input")
    status = value["status"]
    if not isinstance(status, str) or status not in {"pending", "success", "error"}:
        raise traitlets.TraitError("cell result has an invalid status")
    values = value["values"]
    raw_errors = value["errors"]
    if not isinstance(values, Mapping) or any(
        not isinstance(name, str) for name in values
    ):
        raise traitlets.TraitError("cell result values must use string keys")
    try:
        for item in values.values():
            deserialize_value(item)
    except (ValueError, TypeError, OverflowError) as error:
        raise traitlets.TraitError(
            "cell result contains an invalid serialized value"
        ) from error
    if not isinstance(raw_errors, list | tuple):
        raise traitlets.TraitError("cell result errors must be a list")
    errors = [_validate_error_wire(item, cell=True) for item in raw_errors]
    if status == "error" and not errors:
        raise traitlets.TraitError("error results require a structured error")
    if status != "error" and errors:
        raise traitlets.TraitError("structured cell errors require error status")
    if status == "pending" and values:
        raise traitlets.TraitError("pending results cannot expose values")
    return {
        "revision": revision,
        "status": status,
        "values": dict(values),
        "errors": errors,
    }


def _validate_error_wire(value: object, *, cell: bool) -> dict[str, Any]:
    required = {"name", "message", "phase"}
    context_fields = {"origin", "component", "operation", "stack", "cause", "cell"}
    allowed = required | context_fields | ({"variable"} if cell else set())
    if (
        not isinstance(value, Mapping)
        or set(value) - allowed
        or not required <= set(value)
    ):
        raise traitlets.TraitError("structured error has an invalid shape")
    value = cast(Mapping[str, object], value)
    name = value["name"]
    message = value["message"]
    phase = value["phase"]
    variable = value.get("variable")
    if not isinstance(name, str) or not name or not isinstance(message, str):
        raise traitlets.TraitError("structured error name and message are required")
    if not isinstance(phase, str) or phase not in {
        "analysis",
        "evaluation",
        "rendering",
        "serialization",
        "transport",
    }:
        raise traitlets.TraitError("structured error phase is invalid")
    if variable is not None and not isinstance(variable, str):
        raise traitlets.TraitError("structured error variable must be a string")
    result: dict[str, Any] = {"name": name, "message": message, "phase": phase}
    if cell:
        result["variable"] = variable
    for key in context_fields.intersection(value):
        item = value[key]
        if key == "origin":
            if item not in {"notebook", "runtime", "widget"}:
                raise traitlets.TraitError("structured error origin is invalid")
        elif key == "cause":
            errors._error_detail(item)
        elif key == "cell":
            errors._diagnostic_cell(item)
        elif not isinstance(item, str):
            raise traitlets.TraitError(f"structured error {key} must be a string")
        result[key] = item
    return result


def _error_context(error: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "origin": error.get("origin"),
        "component": error.get("component"),
        "operation": error.get("operation"),
        "stack": error.get("stack"),
        "cause": errors._error_detail(error["cause"]) if "cause" in error else None,
        "cell": errors._diagnostic_cell(error["cell"]) if "cell" in error else None,
    }


def _cell_error_from_wire(value: object) -> CellError:
    error = _validate_error_wire(value, cell=True)
    return CellError(
        name=cast(str, error["name"]),
        message=cast(str, error["message"]),
        phase=cast(ErrorPhase, error["phase"]),
        variable=cast(str | None, error["variable"]),
        **_error_context(error),
    )


def _view_error_from_wire(value: object) -> ViewError:
    error = _validate_error_wire(value, cell=False)
    return ViewError(
        name=cast(str, error["name"]),
        message=cast(str, error["message"]),
        phase=cast(ErrorPhase, error["phase"]),
        **_error_context(error),
    )


def _wire_revision(value: object, field: str) -> int:
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or value < 0
        or value > _MAX_SAFE_REVISION
    ):
        raise traitlets.TraitError(f"{field} must be a safe non-negative integer")
    return value


def _optional_wire_revision(value: object, field: str) -> int | None:
    return None if value is None else _wire_revision(value, field)
