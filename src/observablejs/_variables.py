"""Serialize Python values for Observable JavaScript variables.

Python sends data through anywidget as JSON-compatible trait state. Plain values
stay normal JSON. Values that need a browser-side type use
``__observablejs_type__`` tags that ``js/wire.ts`` revives before the OJS runtime
evaluates cells.
"""

from __future__ import annotations

import base64
import dataclasses
import datetime as _dt
import importlib
import math
import re
from collections.abc import Iterable, Mapping
from typing import Any

TYPE_KEY = "__observablejs_type__"
# Keep this tag in sync with `revivePythonValue` and `toWireValue` in js/wire.ts.

_IDENTIFIER_RE = re.compile(r"^[A-Za-z_$][0-9A-Za-z_$]*$")


@dataclasses.dataclass(frozen=True)
class _ArrowValue:
    value: Any


@dataclasses.dataclass(frozen=True)
class _RecordsValue:
    value: Any


def arrow(value: Any) -> _ArrowValue:
    """Serialize a pandas or Polars dataframe as an Arrow IPC table."""

    return _ArrowValue(value)


def records(value: Any) -> _RecordsValue:
    """Serialize dataframe-like values as row records."""

    return _RecordsValue(value)


def serialize_variables(values: Mapping[str, Any] | None) -> dict[str, Any]:
    """Return the synced ``_data`` payload for Observable runtime builtins."""

    if values is None:
        return {}
    if not isinstance(values, Mapping):
        raise TypeError(
            "data must be a mapping of JavaScript identifier names to values"
        )
    out: dict[str, Any] = {}
    for name, value in values.items():
        if not isinstance(name, str) or not _IDENTIFIER_RE.match(name):
            raise ValueError(f"Invalid Observable variable name: {name!r}")
        out[name] = serialize_value(value)
    return out


def serialize_value(value: Any) -> Any:
    """Convert one Python value into the JSON-compatible wire format."""

    if isinstance(value, _ArrowValue):
        arrow_value = _try_arrow_table(value.value)
        if arrow_value is None:
            raise TypeError(
                f"Value of type {type(value.value).__name__!r} cannot be serialized as Arrow"
            )
        return {TYPE_KEY: "arrow", "value": arrow_value}
    if isinstance(value, _RecordsValue):
        records_value = _try_records(value.value)
        if records_value is None:
            raise TypeError(
                f"Value of type {type(value.value).__name__!r} cannot be serialized as records"
            )
        return serialize_value(records_value)
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


def _try_arrow_table(value: Any) -> str | None:
    # Arrow keeps typed dataframe columns available in OJS. Records remain the
    # dependency-free default.
    module, class_name = _value_type(value)
    is_pandas_dataframe = module == "pandas" and class_name == "DataFrame"
    is_polars_dataframe = (
        module == "polars" and class_name == "DataFrame" and hasattr(value, "to_arrow")
    )
    if not (is_pandas_dataframe or is_polars_dataframe):
        return None

    try:
        pa = importlib.import_module("pyarrow")
    except ImportError:
        return None

    try:
        if is_pandas_dataframe:
            table = pa.Table.from_pandas(value, preserve_index=False)
        else:
            table = value.to_arrow()
    except Exception:
        return None

    try:
        sink = pa.BufferOutputStream()
        with pa.ipc.new_file(sink, table.schema) as writer:
            writer.write_table(table)
        return base64.standard_b64encode(sink.getvalue().to_pybytes()).decode("ascii")
    except Exception:
        return None


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
