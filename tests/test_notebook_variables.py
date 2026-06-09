from __future__ import annotations

import datetime as dt
import sys
import types

import pyobservablejs as obs
import pytest
from helpers import BrowserValueSync


def test_python_variables_serialize_to_frontend_state() -> None:
    widget = obs.Notebook(
        obs.ojs("py_answer + rows.length"),
        variables={
            "py_answer": 42,
            "rows": [{"date": dt.date(2026, 5, 23), "value": float("nan")}],
            "raw": b"abc",
            "span": range(3),
        },
    )

    wire = widget.get_state(["_variables"])["_variables"]
    assert widget.variables["rows"][0]["date"] == dt.date(2026, 5, 23)
    assert wire["py_answer"] == 42
    assert wire["rows"][0]["date"] == {
        "__pyobservablejs_type__": "datetime",
        "value": "2026-05-23",
    }
    assert wire["rows"][0]["value"] == {
        "__pyobservablejs_type__": "number",
        "value": "NaN",
    }
    assert wire["raw"] == {
        "__pyobservablejs_type__": "bytes",
        "value": "YWJj",
    }
    assert wire["span"] == [0, 1, 2]


def test_python_ints_serialize_as_bigints_after_js_safe_integer_boundary() -> None:
    widget = obs.Notebook(
        variables={
            "safe": 2**53 - 1,
            "huge": 2**53,
            "negative": -(2**53),
        }
    )

    wire = widget.get_state(["_variables"])["_variables"]
    assert wire["safe"] == 9007199254740991
    assert wire["huge"] == {
        "__pyobservablejs_type__": "bigint",
        "value": "9007199254740992",
    }
    assert wire["negative"] == {
        "__pyobservablejs_type__": "bigint",
        "value": "-9007199254740992",
    }


def test_replace_variables_updates_public_variables() -> None:
    widget = obs.Notebook()

    widget.replace_variables({"py_value": 7})

    assert widget.variables == {"py_value": 7}


def test_variables_update_serializes_merged_frontend_state() -> None:
    widget = obs.Notebook(variables={"py_value": 7})

    widget.update_variables({"other": dt.date(2026, 5, 25)}, py_value=8)

    assert widget.variables == {"py_value": 8, "other": dt.date(2026, 5, 25)}
    assert widget.get_state(["_variables"])["_variables"] == {
        "py_value": 8,
        "other": {
            "__pyobservablejs_type__": "datetime",
            "value": "2026-05-25",
        },
    }


def test_variable_mutators_update_public_variables() -> None:
    widget = obs.Notebook(variables={"gain": 5, "rows": [{"x": 1}]})

    widget.replace_variables({"rows": [{"x": 2}]})

    assert widget.variables == {"rows": [{"x": 2}]}

    widget.update_variables(gain=7)

    assert widget.variables == {"rows": [{"x": 2}], "gain": 7}

    widget.reset_variables("rows")

    assert widget.variables == {"gain": 7}


def test_variable_update_emits_frontend_protocol_packet() -> None:
    widget = obs.Notebook(variables={"gain": 5})

    widget.update_variables(gain=7)

    set_update = widget.get_state(["_variable_update"])["_variable_update"]
    assert set_update["kind"] == "set"
    assert set_update["values"] == {"gain": 7}

    widget.replace_variables({"rows": [{"x": 2}]})

    replace_update = widget.get_state(["_variable_update"])["_variable_update"]
    assert replace_update["kind"] == "replace"
    assert replace_update["values"] == {"rows": [{"x": 2}]}
    assert replace_update["seq"] > set_update["seq"]

    widget.reset_variables("rows")

    reset_update = widget.get_state(["_variable_update"])["_variable_update"]
    assert reset_update["kind"] == "replace"
    assert reset_update["values"] == {}
    assert reset_update["seq"] > replace_update["seq"]


def test_browser_values_are_python_facing_with_wire_escape_hatch(
    browser_value_sync: BrowserValueSync,
) -> None:
    widget = obs.Notebook()

    browser_value_sync(
        widget,
        {
            "when": {
                "__pyobservablejs_type__": "datetime",
                "value": "2026-05-25T10:00:00.000Z",
            },
            "raw": {"__pyobservablejs_type__": "arraybuffer", "value": "YWJj"},
        },
    )

    assert widget.values["when"] == dt.datetime(2026, 5, 25, 10, tzinfo=dt.timezone.utc)
    assert widget.values["raw"] == b"abc"
    assert widget.wire_values["raw"] == {
        "__pyobservablejs_type__": "arraybuffer",
        "value": "YWJj",
    }


def test_browser_bigint_values_decode_to_python_int(
    browser_value_sync: BrowserValueSync,
) -> None:
    widget = obs.Notebook()

    browser_value_sync(
        widget,
        {
            "huge": {
                "__pyobservablejs_type__": "bigint",
                "value": "9007199254740993",
            }
        },
    )

    assert widget.values["huge"] == 9007199254740993


def test_browser_values_with_wire_type_key_decode_as_user_objects(
    browser_value_sync: BrowserValueSync,
) -> None:
    widget = obs.Notebook()

    browser_value_sync(
        widget,
        {
            "row": {
                "__pyobservablejs_type__": "object",
                "value": {
                    "__pyobservablejs_type__": "datetime",
                    "value": "not a date",
                    "other": 1,
                },
            }
        },
    )

    assert widget.values["row"] == {
        "__pyobservablejs_type__": "datetime",
        "value": "not a date",
        "other": 1,
    }


def test_invalid_python_var_name_raises() -> None:
    with pytest.raises(ValueError, match="Invalid Observable variable name"):
        obs.Notebook(variables={"not-valid": 1})


def test_python_variables_with_wire_type_key_serialize_as_user_objects() -> None:
    widget = obs.Notebook(
        variables={"row": {"__pyobservablejs_type__": "not-a-wire-tag", "value": 1}}
    )

    assert widget.get_state(["_variables"])["_variables"]["row"] == {
        "__pyobservablejs_type__": "object",
        "value": {"__pyobservablejs_type__": "not-a-wire-tag", "value": 1},
    }


def test_dataframe_like_values_serialize_as_records_by_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class DataFrame:
        def to_dict(self, orient: str) -> list[dict[str, int]]:
            if orient == "records":
                return [{"x": 1}]
            return [{"split": 1}]

    monkeypatch.setitem(
        sys.modules, "pandas", types.SimpleNamespace(DataFrame=DataFrame)
    )

    widget = obs.Notebook(variables={"rows": DataFrame()})

    assert widget.get_state(["_variables"])["_variables"]["rows"] == [{"x": 1}]


def test_polars_like_values_serialize_when_polars_is_loaded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class DataFrame:
        def to_dicts(self) -> list[dict[str, int]]:
            return [{"x": 1}]

    class Series:
        def to_list(self) -> list[int]:
            return [1, 2]

    monkeypatch.setitem(
        sys.modules,
        "polars",
        types.SimpleNamespace(DataFrame=DataFrame, Series=Series),
    )

    widget = obs.Notebook(variables={"rows": DataFrame(), "x": Series()})

    assert widget.get_state(["_variables"])["_variables"] == {
        "rows": [{"x": 1}],
        "x": [1, 2],
    }
