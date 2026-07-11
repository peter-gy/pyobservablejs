from __future__ import annotations

import datetime as dt
import sys
import types
from typing import Any

import observablejs as obs
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
        "__observablejs_type__": "datetime",
        "value": "2026-05-23",
    }
    assert wire["rows"][0]["value"] == {
        "__observablejs_type__": "number",
        "value": "NaN",
    }
    assert wire["raw"] == {
        "__observablejs_type__": "bytes",
        "value": "YWJj",
    }
    assert wire["span"] == [0, 1, 2]


def test_initial_variable_iterators_materialize_for_python_and_frontend() -> None:
    notebook = obs.Notebook(variables={"rows": (item for item in [1, 2])})

    assert notebook.variables == {"rows": [1, 2]}
    assert notebook.get_state(["_variables"])["_variables"] == {"rows": [1, 2]}


def test_variable_update_materializes_nested_iterators_once() -> None:
    notebook = obs.Notebook(variables={"keep": "unchanged"})
    rows = ({"x": item} for item in [1, 2])

    notebook.update_variables(payload={"rows": rows})

    payload = {"rows": [{"x": 1}, {"x": 2}]}
    assert notebook.variables == {"keep": "unchanged", "payload": payload}
    assert notebook.get_state(["_variables"])["_variables"] == {
        "keep": "unchanged",
        "payload": payload,
    }
    assert notebook.get_state(["_variable_update"])["_variable_update"] == {
        "seq": 1,
        "kind": "set",
        "values": {"payload": payload},
    }


def test_variable_replacement_materializes_iterators_and_preserves_values() -> None:
    notebook = obs.Notebook()
    when = dt.date(2026, 7, 11)

    notebook.replace_variables(
        {
            "rows": (item for item in [1, 2]),
            "when": when,
            "raw": b"abc",
        }
    )

    expected_wire = {
        "rows": [1, 2],
        "when": {
            "__observablejs_type__": "datetime",
            "value": "2026-07-11",
        },
        "raw": {"__observablejs_type__": "bytes", "value": "YWJj"},
    }
    assert notebook.variables == {
        "rows": [1, 2],
        "when": when,
        "raw": b"abc",
    }
    assert notebook.get_state(["_variables"])["_variables"] == expected_wire
    assert notebook.get_state(["_variable_update"])["_variable_update"] == {
        "seq": 1,
        "kind": "replace",
        "values": expected_wire,
    }


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
        "__observablejs_type__": "bigint",
        "value": "9007199254740992",
    }
    assert wire["negative"] == {
        "__observablejs_type__": "bigint",
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
            "__observablejs_type__": "datetime",
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


def test_identical_variable_mutations_are_protocol_noops() -> None:
    notebook = obs.Notebook(variables={"gain": 5, "rows": [{"x": 1}]})
    updates: list[dict[str, object]] = []
    notebook.observe(
        lambda change: updates.append(change["new"]),
        names="_variable_update",
    )

    notebook.update_variables(gain=5.0)
    notebook.replace_variables({"gain": 5.0, "rows": [{"x": 1.0}]})

    assert notebook.variables == {"gain": 5, "rows": [{"x": 1}]}
    assert notebook.get_state(["_variable_update"])["_variable_update"] == {}
    assert updates == []


def test_same_wire_update_reasserts_python_ownership_without_active_views() -> None:
    notebook = obs.Notebook(variables={"x": 7, "z": 100})
    notebook.set_state({"_view_values": {"x": 8, "unrelated": 3}})

    notebook.update_variables(x=7, z=100)

    update = notebook.get_state(["_variable_update"])["_variable_update"]
    assert update == {"seq": 1, "kind": "set", "values": {"x": 7}}
    assert notebook.get_state(["_view_values"])["_view_values"] == {"unrelated": 3}

    notebook.update_variables(z=100)

    assert notebook.get_state(["_variable_update"])["_variable_update"] == update


def test_same_wire_replace_reasserts_python_ownership() -> None:
    variables = {"x": 7, "z": 100}
    notebook = obs.Notebook(variables=variables)
    notebook.set_state({"_view_values": {"x": 8, "unrelated": 3}})

    notebook.replace_variables(variables)

    update = notebook.get_state(["_variable_update"])["_variable_update"]
    assert update == {"seq": 1, "kind": "replace", "values": variables}
    assert notebook.get_state(["_view_values"])["_view_values"] == {"unrelated": 3}

    notebook.replace_variables(variables)

    assert notebook.get_state(["_variable_update"])["_variable_update"] == update


def test_replace_variables_clears_old_and_new_shared_python_names() -> None:
    notebook = obs.Notebook(variables={"old": 1, "keep": 2})
    notebook.set_state({"_view_values": {"old": 10, "new": 30, "unrelated": 3}})

    notebook.replace_variables({"keep": 2, "new": 3})

    assert notebook.get_state(["_view_values"])["_view_values"] == {"unrelated": 3}


def test_reset_variables_clears_shared_values_for_replaced_python_names() -> None:
    notebook = obs.Notebook(variables={"x": 7, "z": 100})
    notebook.set_state({"_view_values": {"x": 8, "z": 101, "unrelated": 3}})

    notebook.reset_variables("x")

    assert notebook.get_state(["_variable_update"])["_variable_update"] == {
        "seq": 1,
        "kind": "replace",
        "values": {"z": 100},
    }
    assert notebook.get_state(["_view_values"])["_view_values"] == {"unrelated": 3}


def test_variable_patch_distinguishes_signed_zero() -> None:
    notebook = obs.Notebook(variables={"gain": -0.0})

    notebook.update_variables(gain=0.0)

    assert notebook.get_state(["_variable_update"])["_variable_update"] == {
        "seq": 1,
        "kind": "set",
        "values": {"gain": 0.0},
    }


def test_variable_patch_distinguishes_booleans_from_numbers() -> None:
    notebook = obs.Notebook(
        variables={
            "scalar": 1,
            "nested": {"values": [0, {"flag": True}]},
        }
    )

    notebook.update_variables(
        scalar=True,
        nested={"values": [False, {"flag": 1}]},
    )

    assert notebook.get_state(["_variable_update"])["_variable_update"] == {
        "seq": 1,
        "kind": "set",
        "values": {
            "scalar": True,
            "nested": {"values": [False, {"flag": 1}]},
        },
    }


def test_variable_replacement_distinguishes_booleans_from_numbers() -> None:
    notebook = obs.Notebook(
        variables={
            "scalar": False,
            "nested": {"values": [True, {"count": 0}]},
        }
    )

    notebook.replace_variables(
        {
            "scalar": 0,
            "nested": {"values": [1, {"count": False}]},
        }
    )

    assert notebook.get_state(["_variable_update"])["_variable_update"] == {
        "seq": 1,
        "kind": "replace",
        "values": {
            "scalar": 0,
            "nested": {"values": [1, {"count": False}]},
        },
    }


def test_variable_patch_sends_changed_names() -> None:
    notebook = obs.Notebook(variables={"gain": 5, "color": "blue"})

    notebook.update_variables(gain=5, color="red")

    assert notebook.get_state(["_variable_update"])["_variable_update"] == {
        "seq": 1,
        "kind": "set",
        "values": {"color": "red"},
    }


def test_notebook_view_delegates_variable_mutations_to_its_session() -> None:
    notebook = obs.Notebook(variables={"gain": 5})
    view = notebook.view()

    view.update_variables(gain=7)
    assert view.variables == {"gain": 7}
    view.replace_variables(color="red")
    assert notebook.variables == {"color": "red"}
    view.reset_variables("color")
    assert notebook.variables == {}


@pytest.mark.parametrize(
    ("name", "message"),
    [
        ("not-valid", "Invalid Observable variable name"),
        (7, "Invalid Observable variable name"),
        ("d3", "Reserved Observable runtime name"),
    ],
)
def test_reset_variables_validates_names(name: Any, message: str) -> None:
    notebook = obs.Notebook(variables={"gain": 5})

    with pytest.raises(ValueError, match=message):
        notebook.reset_variables(name)

    assert notebook.variables == {"gain": 5}
    assert notebook.get_state(["_variable_update"])["_variable_update"] == {}


def test_notebook_view_reset_variables_uses_session_name_validation() -> None:
    notebook = obs.Notebook(variables={"gain": 5})
    view = notebook.view()

    with pytest.raises(ValueError, match="Reserved Observable runtime name"):
        view.reset_variables("d3")

    assert view.variables == {"gain": 5}


def test_reset_variables_ignores_valid_unknown_names() -> None:
    notebook = obs.Notebook(variables={"gain": 5})
    view = notebook.view()

    notebook.reset_variables("unknown")
    view.reset_variables("alsoUnknown")

    assert notebook.variables == {"gain": 5}
    assert notebook.get_state(["_variable_update"])["_variable_update"] == {}


def test_closed_notebook_rejects_variable_mutations() -> None:
    notebook = obs.Notebook(variables={"gain": 5})
    notebook.close()

    with pytest.raises(RuntimeError, match="closed Notebook"):
        notebook.update_variables(gain=7)
    with pytest.raises(RuntimeError, match="closed Notebook"):
        notebook.replace_variables(color="red")
    with pytest.raises(RuntimeError, match="closed Notebook"):
        notebook.reset_variables("gain")

    assert notebook.variables == {"gain": 5}


def test_closed_view_rejects_variable_mutations() -> None:
    notebook = obs.Notebook(variables={"gain": 5})
    view = notebook.view()

    view.close()
    view.close()

    with pytest.raises(RuntimeError, match="closed NotebookView"):
        view.update_variables(gain=7)
    with pytest.raises(RuntimeError, match="closed NotebookView"):
        view.replace_variables(color="red")
    with pytest.raises(RuntimeError, match="closed NotebookView"):
        view.reset_variables("gain")

    assert view.variables == {"gain": 5}
    assert view.cell_indexes is None


def test_closing_notebook_invalidates_view_mutations() -> None:
    notebook = obs.Notebook(variables={"gain": 5})
    view = notebook.view()
    notebook.close()

    with pytest.raises(RuntimeError, match="closed NotebookView"):
        view.update_variables(gain=7)

    assert view.variables == {"gain": 5}


def test_browser_values_decode_to_python_values(
    browser_value_sync: BrowserValueSync,
) -> None:
    view = obs.Notebook().view()

    browser_value_sync(
        view,
        {
            "when": {
                "__observablejs_type__": "datetime",
                "value": "2026-05-25T10:00:00.000Z",
            },
            "raw": {"__observablejs_type__": "arraybuffer", "value": "YWJj"},
        },
    )

    assert view.runtime_values["when"] == dt.datetime(
        2026, 5, 25, 10, tzinfo=dt.timezone.utc
    )
    assert view.runtime_values["raw"] == b"abc"


def test_browser_bigint_values_decode_to_python_int(
    browser_value_sync: BrowserValueSync,
) -> None:
    view = obs.Notebook().view()

    browser_value_sync(
        view,
        {
            "huge": {
                "__observablejs_type__": "bigint",
                "value": "9007199254740993",
            }
        },
    )

    assert view.runtime_values["huge"] == 9007199254740993


def test_browser_summary_values_decode_to_python_string(
    browser_value_sync: BrowserValueSync,
) -> None:
    view = obs.Notebook().view()

    browser_value_sync(
        view,
        {
            "when": {
                "__observablejs_type__": "summary",
                "value": "Invalid Date",
            }
        },
    )

    assert view.runtime_values["when"] == "Invalid Date"


def test_browser_values_with_wire_type_key_decode_as_user_objects(
    browser_value_sync: BrowserValueSync,
) -> None:
    view = obs.Notebook().view()

    browser_value_sync(
        view,
        {
            "row": {
                "__observablejs_type__": "object",
                "value": {
                    "__observablejs_type__": "datetime",
                    "value": "not a date",
                    "other": 1,
                },
            }
        },
    )

    assert view.runtime_values["row"] == {
        "__observablejs_type__": "datetime",
        "value": "not a date",
        "other": 1,
    }


def test_invalid_python_var_name_raises() -> None:
    with pytest.raises(ValueError, match="Invalid Observable variable name"):
        obs.Notebook(variables={"not-valid": 1})


def test_python_variable_name_require_is_allowed() -> None:
    widget = obs.Notebook(variables={"require": "python require"})

    assert widget.variables == {"require": "python require"}
    assert widget.get_state(["_variables"])["_variables"] == {
        "require": "python require"
    }


def test_python_variable_update_name_require_is_allowed() -> None:
    widget = obs.Notebook()

    widget.update_variables(require="python require")

    assert widget.variables == {"require": "python require"}


def test_python_variables_with_wire_type_key_serialize_as_user_objects() -> None:
    widget = obs.Notebook(
        variables={"row": {"__observablejs_type__": "not-a-wire-tag", "value": 1}}
    )

    assert widget.get_state(["_variables"])["_variables"]["row"] == {
        "__observablejs_type__": "object",
        "value": {"__observablejs_type__": "not-a-wire-tag", "value": 1},
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
