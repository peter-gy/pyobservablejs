"""Serialize Python values for Observable JavaScript variables.

Python sends variables through anywidget as JSON-compatible trait state. Plain values
stay normal JSON. Values that need a browser-side type use
``__observablejs_type__`` tags that ``packages/runtime/src/values.ts`` revives
before the OJS runtime evaluates cells.
"""

from __future__ import annotations

import base64
import datetime as _dt
import math
import re
import sys
from collections.abc import Collection, Iterable, Iterator, Mapping
from typing import Any

TYPE_KEY = "__observablejs_type__"
_MAX_SAFE_JS_INTEGER = 9_007_199_254_740_991

_IDENTIFIER_RE = re.compile(r"^[A-Za-z_$][0-9A-Za-z_$]*$")
RESERVED_VARIABLE_NAMES = frozenset(
    {
        "Arrow",
        "DOM",
        "DatabaseClient",
        "DuckDBClient",
        "FileAttachment",
        "Files",
        "Generators",
        "Inputs",
        "Interpreter",
        "L",
        "Mutable",
        "Plot",
        "Promises",
        "React",
        "ReactDOM",
        "SQLite",
        "SQLiteDatabaseClient",
        "_",
        "__ojs_observer",
        "aapl",
        "alphabet",
        "aq",
        "cars",
        "citywages",
        "d3",
        "dark",
        "diamonds",
        "document",
        "dot",
        "duckdb",
        "echarts",
        "flare",
        "htl",
        "html",
        "industries",
        "invalidation",
        "mapboxgl",
        "md",
        "mermaid",
        "miserables",
        "now",
        "olympians",
        "penguins",
        "pizza",
        "svg",
        "tex",
        "topojson",
        "vl",
        "visibility",
        "weather",
        "width",
    }
)
OBSERVABLE_RESERVED_VARIABLE_NAMES = frozenset({"__query", "require", "resolve"})


def prepare_variables(
    values: Mapping[str, Any] | None,
    *,
    reserved_names: Collection[str] = (),
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Return replayable Python values and their serialized wire snapshot."""

    if values is None:
        return {}, {}
    if not isinstance(values, Mapping):
        raise TypeError(
            "variables must be a mapping of JavaScript identifier names to values"
        )
    prepared: dict[str, Any] = {}
    serialized: dict[str, Any] = {}
    for name, value in values.items():
        validate_variable_name(name, reserved_names=reserved_names)
        prepared_value = _materialize_iterators(value)
        prepared[name] = prepared_value
        serialized[name] = serialize_value(prepared_value)
    return prepared, serialized


def _materialize_iterators(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {key: _materialize_iterators(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_materialize_iterators(item) for item in value]
    if isinstance(value, tuple):
        return tuple(_materialize_iterators(item) for item in value)
    if isinstance(value, Iterator):
        return [_materialize_iterators(item) for item in value]

    return value


def same_wire_value(left: Any, right: Any) -> bool:
    """Compare serialized values using JavaScript value categories."""

    if left is right:
        return True
    if isinstance(left, bool) or isinstance(right, bool):
        return isinstance(left, bool) and isinstance(right, bool) and left == right
    if isinstance(left, int | float) and isinstance(right, int | float):
        left_number = float(left)
        right_number = float(right)
        if math.isnan(left_number) or math.isnan(right_number):
            return math.isnan(left_number) and math.isnan(right_number)
        if left_number == 0 and right_number == 0:
            return math.copysign(1, left_number) == math.copysign(1, right_number)
        return left_number == right_number
    if type(left) is not type(right):
        return False
    if isinstance(left, list):
        return len(left) == len(right) and all(
            same_wire_value(left_item, right_item)
            for left_item, right_item in zip(left, right, strict=True)
        )
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(
            same_wire_value(left[key], right[key]) for key in left
        )
    return bool(left == right)


def validate_variable_name(
    name: object,
    *,
    reserved_names: Collection[str] = (),
) -> str:
    if not isinstance(name, str) or not _IDENTIFIER_RE.match(name):
        raise ValueError(f"Invalid Observable variable name: {name!r}")
    if name in RESERVED_VARIABLE_NAMES or name in reserved_names:
        raise ValueError(f"Reserved Observable runtime name: {name!r}")
    return name


def variable_updates_from_args(
    name: str,
    values: Mapping[str, Any] | Iterable[tuple[str, Any]] | None,
    kwargs: Mapping[str, Any],
) -> dict[str, Any]:
    updates: dict[str, Any] = {}
    if values is not None:
        if isinstance(values, Mapping):
            updates.update(values)
        else:
            try:
                updates.update(dict(values))
            except (TypeError, ValueError) as exc:
                raise TypeError(f"{name} expects a mapping or key/value pairs") from exc
    updates.update(kwargs)
    return updates


def serialize_value(value: Any) -> Any:
    """Convert one Python value into the JSON-compatible wire format."""

    if value is None or isinstance(value, bool | str):
        return value
    if isinstance(value, int):
        if abs(value) <= _MAX_SAFE_JS_INTEGER:
            return value
        return {TYPE_KEY: "bigint", "value": str(value)}
    if isinstance(value, float):
        if math.isfinite(value):
            return value
        if math.isnan(value):
            return {TYPE_KEY: "number", "value": "NaN"}
        return {TYPE_KEY: "number", "value": "Infinity" if value > 0 else "-Infinity"}
    if isinstance(value, _dt.datetime | _dt.date):
        return {TYPE_KEY: "datetime", "value": value.isoformat()}
    if isinstance(value, bytes | bytearray | memoryview):
        data = bytes(value)
        return {
            TYPE_KEY: "bytes",
            "value": base64.standard_b64encode(data).decode("ascii"),
        }

    records = _try_dataframe_records(value)
    if records is not None:
        return serialize_value(records)

    series = _try_series_values(value)
    if series is not None:
        return serialize_value(series)

    numpy_value = _try_numpy_value(value)
    if numpy_value is not _MISSING:
        return serialize_value(numpy_value)

    if isinstance(value, Mapping):
        serialized = {str(k): serialize_value(v) for k, v in value.items()}
        if TYPE_KEY in serialized:
            return {TYPE_KEY: "object", "value": serialized}
        return serialized
    if isinstance(value, range):
        return list(value)
    if isinstance(value, Iterable):
        return [serialize_value(v) for v in value]

    raise TypeError(f"Value of type {type(value).__name__!r} is not serializable")


def deserialize_value(value: Any) -> Any:
    """Convert browser wire values into Python-facing values.

    Dates, bytes, array buffers, typed arrays, bigints, maps, sets, files, and
    blobs are decoded to Python values or metadata. DOM elements, functions,
    errors, regular expressions, circular references, and unknown tags become
    strings or plain dictionaries.
    """

    if isinstance(value, list):
        return [deserialize_value(item) for item in value]
    if not isinstance(value, Mapping):
        return value

    tag = value.get(TYPE_KEY)
    if tag is None:
        return {key: deserialize_value(item) for key, item in value.items()}
    if tag == "undefined":
        return None
    if tag == "number":
        raw = str(value.get("value"))
        if raw == "NaN":
            return math.nan
        if raw == "Infinity":
            return math.inf
        if raw == "-Infinity":
            return -math.inf
        return float(raw)
    if tag == "bigint":
        return int(str(value.get("value")))
    if tag == "datetime":
        raw = str(value.get("value"))
        try:
            return _dt.datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            return raw
    if tag == "bytes" or tag == "arraybuffer":
        return base64.standard_b64decode(str(value.get("value")))
    if tag == "typedarray":
        return base64.standard_b64decode(str(value.get("value")))
    if tag == "element":
        return f"<{value.get('value')}>"
    if tag == "function":
        return f"[Function {value.get('value')}]"
    if tag == "error":
        return f"{value.get('name')}: {value.get('message')}"
    if tag == "regexp":
        return str(value.get("value"))
    if tag == "summary":
        return str(value.get("value"))
    if tag == "file":
        return {
            "name": value.get("name"),
            "size": value.get("size"),
            "mime_type": value.get("mimeType"),
        }
    if tag == "blob":
        return {"size": value.get("size"), "mime_type": value.get("mimeType")}
    if tag == "reference":
        return f"[Circular reference {value.get('value')}]"
    if tag == "object":
        raw = value.get("value")
        if isinstance(raw, Mapping):
            return {key: deserialize_value(item) for key, item in raw.items()}
        return deserialize_value(raw)
    if tag == "map" and isinstance(value.get("value"), list):
        return [
            tuple(deserialize_value(item) for item in entry)
            if isinstance(entry, list)
            else deserialize_value(entry)
            for entry in value["value"]
        ]
    if tag == "set" and isinstance(value.get("value"), list):
        return [deserialize_value(item) for item in value["value"]]
    return {key: deserialize_value(item) for key, item in value.items()}


def _try_dataframe_records(value: Any) -> Any | None:
    if _is_loaded_type(value, "polars", "DataFrame") and hasattr(value, "to_dicts"):
        return value.to_dicts()
    if _is_loaded_type(value, "pandas", "DataFrame") and hasattr(value, "to_dict"):
        return value.to_dict(orient="records")
    return None


def _try_series_values(value: Any) -> Any | None:
    if _is_loaded_type(value, "polars", "Series") and hasattr(value, "to_list"):
        return value.to_list()
    if _is_loaded_type(value, "pandas", "Series") and hasattr(value, "tolist"):
        return value.tolist()
    return None


_MISSING = object()


def _try_numpy_value(value: Any) -> Any:
    if not _is_loaded_module(value, "numpy"):
        return _MISSING
    if hasattr(value, "tolist"):
        return value.tolist()
    if hasattr(value, "item"):
        return value.item()
    return _MISSING


def _is_loaded_type(value: Any, module_name: str, type_name: str) -> bool:
    module = sys.modules.get(module_name)
    loaded_type = getattr(module, type_name, None)
    return isinstance(loaded_type, type) and isinstance(value, loaded_type)


def _is_loaded_module(value: Any, module_name: str) -> bool:
    return type(value).__module__.split(".", maxsplit=1)[0] == module_name
