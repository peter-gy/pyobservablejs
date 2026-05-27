"""Serialize Python values for Observable JavaScript variables.

Python sends variables through anywidget as JSON-compatible trait state. Plain values
stay normal JSON. Values that need a browser-side type use
``__pyobservablejs_type__`` tags that ``js/wire.ts`` revives before the OJS runtime
evaluates cells.
"""

from __future__ import annotations

import base64
import datetime as _dt
import math
import re
from collections.abc import Iterable, Mapping
from typing import Any

TYPE_KEY = "__pyobservablejs_type__"
# Keep this tag in sync with `revivePythonValue` and `toWireValue` in js/wire.ts.

_IDENTIFIER_RE = re.compile(r"^[A-Za-z_$][0-9A-Za-z_$]*$")


def serialize_variables(values: Mapping[str, Any] | None) -> dict[str, Any]:
    """Return the synced ``_variables`` payload for Observable runtime builtins."""

    if values is None:
        return {}
    if not isinstance(values, Mapping):
        raise TypeError(
            "variables must be a mapping of JavaScript identifier names to values"
        )
    out: dict[str, Any] = {}
    for name, value in values.items():
        if not isinstance(name, str) or not _IDENTIFIER_RE.match(name):
            raise ValueError(f"Invalid Observable variable name: {name!r}")
        out[name] = serialize_value(value)
    return out


def serialize_value(value: Any) -> Any:
    """Convert one Python value into the JSON-compatible wire format."""

    if value is None or isinstance(value, bool | int | str):
        return value
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

    records = _try_records(value)
    if records is not None:
        return serialize_value(records)

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
    """Convert browser wire values into Python-facing values where possible."""

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
        return deserialize_value(value.get("value"))
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


def _try_records(value: Any) -> Any | None:
    module, class_name = _value_type(value)
    if module == "pandas" and class_name == "DataFrame" and hasattr(value, "to_dict"):
        return value.to_dict(orient="records")
    if module == "pandas" and class_name == "Series" and hasattr(value, "tolist"):
        return value.tolist()
    if module == "polars" and class_name == "DataFrame" and hasattr(value, "to_dicts"):
        return value.to_dicts()
    if module == "polars" and class_name == "Series" and hasattr(value, "to_list"):
        return value.to_list()
    return None


_MISSING = object()


def _try_numpy_value(value: Any) -> Any:
    module, _ = _value_type(value)
    if module != "numpy":
        return _MISSING
    if hasattr(value, "tolist"):
        return value.tolist()
    if hasattr(value, "item"):
        return value.item()
    return _MISSING


def _value_type(value: Any) -> tuple[str, str]:
    value_type = type(value)
    return value_type.__module__.split(".", maxsplit=1)[0], value_type.__name__
