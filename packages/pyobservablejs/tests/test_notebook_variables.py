from __future__ import annotations

import datetime as dt
import sys
import types
from typing import Any, cast

import observablejs as obs
import pytest
import traitlets
from helpers import BrowserValueSync, notebook_session


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

    wire = notebook_session(widget).get_state(["_variables"])["_variables"]
    assert cast(Any, widget.variables["rows"])[0]["date"] == dt.datetime.fromisoformat(
        "2026-05-23"
    )
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

    assert notebook.variables == {"rows": (1, 2)}
    assert notebook_session(notebook).get_state(["_variables"])["_variables"] == {
        "rows": [1, 2]
    }


def test_notebook_state_is_detached_and_recursively_read_only() -> None:
    source = {
        "config": {"rows": [{"x": 1}]},
        "raw": bytearray(b"abc"),
    }
    theme: obs.types.ThemePair = {"light": "air", "dark": "ink"}
    file_spec: obs.types.FileSpec = {
        "url": "https://example.test/data.csv",
        "mimeType": "text/csv",
    }
    notebook = obs.Notebook(
        variables=source,
        theme=theme,
        files={"data.csv": file_spec},
    )
    snapshot = notebook.state

    source["config"]["rows"][0]["x"] = 9
    source["raw"].extend(b"def")
    theme["light"] = "coffee"
    file_spec["url"] = "https://example.test/changed.csv"

    assert notebook.state is snapshot
    assert notebook.variables == {
        "config": {"rows": ({"x": 1},)},
        "raw": b"abc",
    }
    assert notebook.theme == {"light": "air", "dark": "ink"}
    assert notebook.attachments["data.csv"]["url"] == ("https://example.test/data.csv")
    mutable_variables = cast(Any, notebook.variables)
    mutable_attachments = cast(Any, notebook.attachments)
    with pytest.raises(TypeError):
        mutable_variables["new"] = 1
    with pytest.raises(TypeError):
        mutable_variables["config"]["rows"][0]["x"] = 2
    with pytest.raises(AttributeError):
        mutable_variables["config"]["rows"].append({"x": 2})
    with pytest.raises(TypeError):
        mutable_attachments["data.csv"]["url"] = "changed"
    with pytest.raises(traitlets.TraitError):
        notebook.state = obs.types.NotebookState({}, {}, "air")


def test_notebook_state_emits_once_per_effective_mutation() -> None:
    notebook = obs.Notebook(variables={"gain": 5})
    changes: list[Any] = []
    notebook.observe(changes.append, names="state")

    notebook.update_variables({"gain": 5})
    assert changes == []

    notebook.update_variables({"gain": 7})
    assert len(changes) == 1
    assert changes[-1]["new"].variables == {"gain": 7}

    notebook.replace_variables({"gain": 7})
    notebook.reset_variables("unknown")
    assert len(changes) == 1

    notebook.replace_variables({"rows": [{"x": 1}]})
    assert len(changes) == 2
    assert changes[-1]["new"].variables == {"rows": ({"x": 1},)}

    notebook.reset_variables("rows")
    assert len(changes) == 3
    assert changes[-1]["new"].variables == {}

    notebook.theme = "ink"
    assert len(changes) == 4
    assert changes[-1]["new"].theme == "ink"

    notebook.theme = "ink"
    assert len(changes) == 4


@pytest.mark.parametrize("method_name", ["update_variables", "replace_variables"])
def test_variable_mutators_accept_exactly_one_mapping(method_name: str) -> None:
    notebook = obs.Notebook()
    method: Any = getattr(notebook, method_name)

    method({"gain": 7})
    with pytest.raises(TypeError):
        method()
    with pytest.raises(TypeError, match="one mapping"):
        method(None)
    with pytest.raises(TypeError, match="one mapping"):
        method([("gain", 8)])
    with pytest.raises(TypeError):
        method(gain=8)


def test_variable_update_materializes_nested_iterators_once() -> None:
    notebook = obs.Notebook(variables={"keep": "unchanged"})
    rows = ({"x": item} for item in [1, 2])

    notebook.update_variables({"payload": {"rows": rows}})

    payload = {"rows": [{"x": 1}, {"x": 2}]}
    assert notebook.variables["payload"] == {"rows": ({"x": 1}, {"x": 2})}
    assert notebook_session(notebook).get_state(["_variables"])["_variables"] == {
        "keep": "unchanged",
        "payload": payload,
    }
    assert notebook_session(notebook).get_state(["_variable_update"])[
        "_variable_update"
    ] == {
        "seq": 1,
        "kind": "set",
        "values": {"payload": payload},
    }


def test_variable_replacement_exposes_browser_normalized_snapshot() -> None:
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
        "rows": (1, 2),
        "when": dt.datetime.fromisoformat("2026-07-11"),
        "raw": b"abc",
    }
    assert (
        notebook_session(notebook).get_state(["_variables"])["_variables"]
        == expected_wire
    )
    assert notebook_session(notebook).get_state(["_variable_update"])[
        "_variable_update"
    ] == {
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

    wire = notebook_session(widget).get_state(["_variables"])["_variables"]
    assert wire["safe"] == 9007199254740991
    assert wire["huge"] == {
        "__observablejs_type__": "bigint",
        "value": "9007199254740992",
    }
    assert wire["negative"] == {
        "__observablejs_type__": "bigint",
        "value": "-9007199254740992",
    }


def test_variables_update_serializes_merged_frontend_state() -> None:
    widget = obs.Notebook(variables={"py_value": 7})

    widget.update_variables({"other": dt.date(2026, 5, 25), "py_value": 8})

    assert widget.variables == {
        "py_value": 8,
        "other": dt.datetime.fromisoformat("2026-05-25"),
    }
    assert notebook_session(widget).get_state(["_variables"])["_variables"] == {
        "py_value": 8,
        "other": {
            "__observablejs_type__": "datetime",
            "value": "2026-05-25",
        },
    }


def test_variable_mutators_update_public_variables() -> None:
    widget = obs.Notebook(variables={"gain": 5, "rows": [{"x": 1}]})

    widget.replace_variables({"rows": [{"x": 2}]})

    assert widget.variables == {"rows": ({"x": 2},)}

    widget.update_variables({"gain": 7})

    assert widget.variables == {"rows": ({"x": 2},), "gain": 7}

    widget.reset_variables("rows")

    assert widget.variables == {"gain": 7}


def test_variable_update_emits_frontend_protocol_packet() -> None:
    widget = obs.Notebook(variables={"gain": 5})

    widget.update_variables({"gain": 7})

    set_update = notebook_session(widget).get_state(["_variable_update"])[
        "_variable_update"
    ]
    assert set_update["kind"] == "set"
    assert set_update["values"] == {"gain": 7}

    widget.replace_variables({"rows": [{"x": 2}]})

    replace_update = notebook_session(widget).get_state(["_variable_update"])[
        "_variable_update"
    ]
    assert replace_update["kind"] == "replace"
    assert replace_update["values"] == {"rows": [{"x": 2}]}
    assert replace_update["seq"] > set_update["seq"]

    widget.reset_variables("rows")

    reset_update = notebook_session(widget).get_state(["_variable_update"])[
        "_variable_update"
    ]
    assert reset_update["kind"] == "replace"
    assert reset_update["values"] == {}
    assert reset_update["seq"] > replace_update["seq"]


def test_identical_variable_mutations_are_protocol_noops() -> None:
    notebook = obs.Notebook(variables={"gain": 5, "rows": [{"x": 1}]})
    updates: list[dict[str, object]] = []
    notebook_session(notebook).observe(
        lambda change: updates.append(change["new"]),
        names="_variable_update",
    )

    notebook.update_variables({"gain": 5.0})
    notebook.replace_variables({"gain": 5.0, "rows": [{"x": 1.0}]})

    assert notebook.variables == {"gain": 5, "rows": ({"x": 1},)}
    assert (
        notebook_session(notebook).get_state(["_variable_update"])["_variable_update"]
        == {}
    )
    assert updates == []


def test_identical_python_update_preserves_browser_owned_view_state() -> None:
    notebook = obs.Notebook(variables={"z": 100})
    notebook_session(notebook).set_state({"_view_values": {"x": 8}})
    updates: list[dict[str, object]] = []
    notebook_session(notebook).observe(
        lambda change: updates.append(change["new"]),
        names="_variable_update",
    )

    notebook.update_variables({"z": 100})

    assert notebook_session(notebook).get_state(["_view_values"])["_view_values"] == {
        "x": 8
    }
    assert (
        notebook_session(notebook).get_state(["_variable_update"])["_variable_update"]
        == {}
    )
    assert updates == []


def test_same_wire_update_reasserts_python_ownership_without_active_views() -> None:
    notebook = obs.Notebook(variables={"x": 7, "z": 100})
    notebook_session(notebook).set_state({"_view_values": {"x": 8, "unrelated": 3}})

    notebook.update_variables({"x": 7, "z": 100})

    update = notebook_session(notebook).get_state(["_variable_update"])[
        "_variable_update"
    ]
    assert update == {"seq": 1, "kind": "set", "values": {"x": 7}}
    assert notebook_session(notebook).get_state(["_view_values"])["_view_values"] == {
        "unrelated": 3
    }

    notebook.update_variables({"z": 100})

    assert (
        notebook_session(notebook).get_state(["_variable_update"])["_variable_update"]
        == update
    )


def test_same_wire_replace_reasserts_python_ownership() -> None:
    variables = {"x": 7, "z": 100}
    notebook = obs.Notebook(variables=variables)
    notebook_session(notebook).set_state({"_view_values": {"x": 8, "unrelated": 3}})

    notebook.replace_variables(variables)

    update = notebook_session(notebook).get_state(["_variable_update"])[
        "_variable_update"
    ]
    assert update == {"seq": 1, "kind": "replace", "values": variables}
    assert notebook_session(notebook).get_state(["_view_values"])["_view_values"] == {
        "unrelated": 3
    }

    notebook.replace_variables(variables)

    assert (
        notebook_session(notebook).get_state(["_variable_update"])["_variable_update"]
        == update
    )


def test_replace_variables_clears_old_and_new_shared_python_names() -> None:
    notebook = obs.Notebook(variables={"old": 1, "keep": 2})
    notebook_session(notebook).set_state(
        {"_view_values": {"old": 10, "new": 30, "unrelated": 3}}
    )

    notebook.replace_variables({"keep": 2, "new": 3})

    assert notebook_session(notebook).get_state(["_view_values"])["_view_values"] == {
        "unrelated": 3
    }


def test_reset_variables_clears_shared_values_for_replaced_python_names() -> None:
    notebook = obs.Notebook(variables={"x": 7, "z": 100})
    notebook_session(notebook).set_state(
        {"_view_values": {"x": 8, "z": 101, "unrelated": 3}}
    )

    notebook.reset_variables("x")

    assert notebook_session(notebook).get_state(["_variable_update"])[
        "_variable_update"
    ] == {
        "seq": 1,
        "kind": "replace",
        "values": {"z": 100},
    }
    assert notebook_session(notebook).get_state(["_view_values"])["_view_values"] == {
        "unrelated": 3
    }


def test_variable_patch_distinguishes_signed_zero() -> None:
    notebook = obs.Notebook(variables={"gain": -0.0})

    notebook.update_variables({"gain": 0.0})

    assert notebook_session(notebook).get_state(["_variable_update"])[
        "_variable_update"
    ] == {
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
        {"scalar": True, "nested": {"values": [False, {"flag": 1}]}}
    )

    assert notebook_session(notebook).get_state(["_variable_update"])[
        "_variable_update"
    ] == {
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

    assert notebook_session(notebook).get_state(["_variable_update"])[
        "_variable_update"
    ] == {
        "seq": 1,
        "kind": "replace",
        "values": {
            "scalar": 0,
            "nested": {"values": [1, {"count": False}]},
        },
    }


def test_variable_patch_sends_changed_names() -> None:
    notebook = obs.Notebook(variables={"gain": 5, "color": "blue"})

    notebook.update_variables({"gain": 5, "color": "red"})

    assert notebook_session(notebook).get_state(["_variable_update"])[
        "_variable_update"
    ] == {
        "seq": 1,
        "kind": "set",
        "values": {"color": "red"},
    }


def test_notebook_view_exposes_its_owning_notebook() -> None:
    notebook = obs.Notebook(variables={"gain": 5})
    view = notebook.view()

    notebook.update_variables({"gain": 7})

    assert view.notebook is notebook
    assert view.notebook.variables == {"gain": 7}


@pytest.mark.parametrize("name", ["invalidation", "visibility"])
def test_python_variables_reserve_runtime_core_names(name: str) -> None:
    message = f"Reserved Observable runtime name: {name!r}"

    with pytest.raises(ValueError, match=message):
        obs.Notebook(variables={name: "shadowed"})


def test_notebook_kit_variables_can_use_classic_runtime_names() -> None:
    notebook = obs.Notebook(variables={"require": "python require"})

    assert notebook.variables == {"require": "python require"}


@pytest.mark.parametrize("name", ["__query", "require", "resolve"])
def test_observablehq_variables_reserve_classic_runtime_names(name: str) -> None:
    message = f"Reserved Observable runtime name: {name!r}"

    with pytest.raises(ValueError, match=message):
        obs.Notebook.from_observablehq_document(
            {"nodes": []}, variables={name: "shadowed"}
        )


def test_observablehq_variable_mutations_reserve_classic_runtime_names() -> None:
    notebook = obs.Notebook.from_observablehq_document({"nodes": []})
    message = "Reserved Observable runtime name: 'require'"

    with pytest.raises(ValueError, match=message):
        notebook.update_variables({"require": "shadowed"})
    with pytest.raises(ValueError, match=message):
        notebook.replace_variables({"require": "shadowed"})
    with pytest.raises(ValueError, match=message):
        notebook.reset_variables("require")

    assert notebook.variables == {}


@pytest.mark.parametrize(
    ("name", "message"),
    [
        ("not-valid", "Invalid Observable variable name"),
        (7, "Invalid Observable variable name"),
        ("invalidation", "Reserved Observable runtime name"),
    ],
)
def test_reset_variables_validates_names(name: Any, message: str) -> None:
    notebook = obs.Notebook(variables={"gain": 5})

    with pytest.raises(ValueError, match=message):
        notebook.reset_variables(name)

    assert notebook.variables == {"gain": 5}
    assert (
        notebook_session(notebook).get_state(["_variable_update"])["_variable_update"]
        == {}
    )


def test_reset_variables_ignores_valid_unknown_names() -> None:
    notebook = obs.Notebook(variables={"gain": 5})
    view = notebook.view()

    notebook.reset_variables("unknown")

    assert notebook.variables == {"gain": 5}
    assert view.notebook is notebook
    assert (
        notebook_session(notebook).get_state(["_variable_update"])["_variable_update"]
        == {}
    )


def test_closed_notebook_rejects_variable_mutations() -> None:
    notebook = obs.Notebook(variables={"gain": 5})
    notebook.close()

    with pytest.raises(RuntimeError, match="closed Notebook"):
        notebook.update_variables({"gain": 7})
    with pytest.raises(RuntimeError, match="closed Notebook"):
        notebook.replace_variables({"color": "red"})
    with pytest.raises(RuntimeError, match="closed Notebook"):
        notebook.reset_variables("gain")

    assert notebook.variables == {"gain": 5}


def test_closed_view_leaves_its_notebook_session_mutable() -> None:
    notebook = obs.Notebook(variables={"gain": 5})
    view = notebook.view()

    view.close()
    view.close()

    notebook.update_variables({"gain": 6})
    assert view.notebook is notebook
    assert notebook.variables == {"gain": 6}


def test_browser_values_decode_to_python_values(
    browser_value_sync: BrowserValueSync,
) -> None:
    view = obs.Notebook(obs.ojs("value", key="readback")).view("readback")

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

    values = view.state.result("readback").values
    assert values["when"] == dt.datetime(2026, 5, 25, 10, tzinfo=dt.timezone.utc)
    assert values["raw"] == b"abc"


def test_browser_bigint_values_decode_to_python_int(
    browser_value_sync: BrowserValueSync,
) -> None:
    view = obs.Notebook(obs.ojs("value", key="readback")).view("readback")

    browser_value_sync(
        view,
        {
            "huge": {
                "__observablejs_type__": "bigint",
                "value": "9007199254740993",
            }
        },
    )

    assert view.state.result("readback").values["huge"] == 9007199254740993


def test_browser_error_values_remain_successful_structured_data(
    browser_value_sync: BrowserValueSync,
) -> None:
    view = obs.Notebook(obs.ojs("new Error('invalid value')", key="readback")).view(
        "readback"
    )

    browser_value_sync(
        view,
        {
            "readback": {
                "__observablejs_type__": "error",
                "name": "TypeError",
                "message": "invalid value",
            }
        },
    )

    result = view.state.result("readback")
    assert result.status == "success"
    assert result.errors == ()
    assert result.values["readback"] == obs.types.BrowserErrorValue(
        name="TypeError",
        message="invalid value",
    )


def test_browser_summary_values_decode_to_python_string(
    browser_value_sync: BrowserValueSync,
) -> None:
    view = obs.Notebook(obs.ojs("value", key="readback")).view("readback")

    browser_value_sync(
        view,
        {
            "when": {
                "__observablejs_type__": "summary",
                "value": "Invalid Date",
            }
        },
    )

    assert view.state.result("readback").values["when"] == "Invalid Date"


def test_browser_values_with_wire_type_key_decode_as_user_objects(
    browser_value_sync: BrowserValueSync,
) -> None:
    view = obs.Notebook(obs.ojs("value", key="readback")).view("readback")

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

    assert view.state.result("readback").values["row"] == {
        "__observablejs_type__": "datetime",
        "value": "not a date",
        "other": 1,
    }


def test_invalid_python_var_name_raises() -> None:
    with pytest.raises(ValueError, match="Invalid Observable variable name"):
        obs.Notebook(variables={"not-valid": 1})


def test_python_variables_with_wire_type_key_serialize_as_user_objects() -> None:
    widget = obs.Notebook(
        variables={"row": {"__observablejs_type__": "not-a-wire-tag", "value": 1}}
    )

    assert notebook_session(widget).get_state(["_variables"])["_variables"]["row"] == {
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

    assert notebook_session(widget).get_state(["_variables"])["_variables"]["rows"] == [
        {"x": 1}
    ]
    assert widget.variables["rows"] == ({"x": 1},)


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

    assert notebook_session(widget).get_state(["_variables"])["_variables"] == {
        "rows": [{"x": 1}],
        "x": [1, 2],
    }
