from __future__ import annotations

import datetime as dt
import importlib.util
import inspect
import pathlib
import sys
import types
from typing import Any

import anywidget
import pyobservablejs as obs
import pytest
import traitlets
from pyobservablejs._graph import CellInfo, DependencyEdge, NotebookGraph
from pyobservablejs._observable import (
    observable_document_to_html,
    resolve_observablehq_api_url,
)


def _notebook_from_html_file(path: pathlib.Path, **kwargs: Any) -> obs.Notebook:
    return obs.Notebook.from_html(
        path.read_text(encoding="utf-8"),
        base_path=path.parent,
        **kwargs,
    )


def test_public_namespace_is_small() -> None:
    assert set(obs.__all__) == {"Notebook", "html", "js", "md", "ojs"}


def test_public_signatures_hide_widget_internals() -> None:
    notebook = inspect.signature(obs.Notebook)
    assert list(notebook.parameters) == [
        "cells",
        "title",
        "theme",
        "mode",
        "attachments",
        "base_path",
        "variables",
        "show_pinned_source",
    ]
    assert not any(name.startswith("_") for name in notebook.parameters)
    assert "data" not in notebook.parameters

    for constructor in (obs.Notebook.from_html, obs.Notebook.from_observablehq):
        params = inspect.signature(constructor).parameters
        assert "variables" in params
        assert "data" not in params
        assert not any(name.startswith("_") for name in params)

    helper_names = [
        "source",
        "name",
        "display",
        "raw",
        "id",
        "pinned",
        "output",
        "attrs",
    ]
    for helper in (obs.ojs, obs.js, obs.md, obs.html):
        params = inspect.signature(helper).parameters
        assert list(params) == helper_names
        assert params["source"].kind is inspect.Parameter.POSITIONAL_OR_KEYWORD
        assert all(
            param.kind is inspect.Parameter.KEYWORD_ONLY
            for name, param in params.items()
            if name != "source"
        )
        assert "database" not in params
        assert "format" not in params


def test_legacy_api_names_are_absent() -> None:
    widget = obs.Notebook()

    assert importlib.util.find_spec("observablejs") is None
    assert not hasattr(widget, "data")
    assert not hasattr(widget, "update_data")
    assert not hasattr(widget, "defining_cell")
    assert not hasattr(obs, "cell")
    assert not hasattr(obs, "sql")
    assert not hasattr(obs, "Cell")
    assert not hasattr(obs, "NotebookCell")
    assert not hasattr(obs, "CellInfo")
    assert not hasattr(obs, "DependencyEdge")
    assert not hasattr(obs, "NotebookGraph")
    assert not hasattr(obs, "arrow")
    assert not hasattr(obs, "records")
    assert not hasattr(obs.Notebook, "from_file")
    assert not hasattr(obs.Notebook, "from_url")
    assert not hasattr(obs.Notebook(obs.ojs("answer = 42")).cell(0), "get")


def test_sql_mode_is_not_publicly_authorable() -> None:
    mode: Any = "sql"
    with pytest.raises(ValueError, match="Unsupported Python-authored cell mode"):
        obs.Notebook("select 1", mode=mode)


def test_observablehq_specifier_resolution_matches_document_api() -> None:
    assert (
        resolve_observablehq_api_url("https://observablehq.com/@d3/bar-chart")
        == "https://api.observablehq.com/document/@d3/bar-chart"
    )
    assert (
        resolve_observablehq_api_url("https://observablehq.com/@d3/bar-chart/2")
        == "https://api.observablehq.com/document/@d3/bar-chart/2"
    )
    assert (
        resolve_observablehq_api_url("https://observablehq.com/@d3/bar-chart@latest")
        == "https://api.observablehq.com/document/@d3/bar-chart@latest"
    )
    assert (
        resolve_observablehq_api_url("https://observablehq.com/d/1234567890abcdef")
        == "https://api.observablehq.com/document/1234567890abcdef"
    )
    assert (
        resolve_observablehq_api_url("@d3/bar-chart")
        == "https://api.observablehq.com/document/@d3/bar-chart"
    )
    assert (
        resolve_observablehq_api_url("1234567890abcdef")
        == "https://api.observablehq.com/document/1234567890abcdef"
    )
    with pytest.raises(ValueError, match="Invalid ObservableHQ notebook specifier"):
        resolve_observablehq_api_url("https://example.com/@d3/bar-chart")


def test_observable_document_serializes_to_notebook_kit_html() -> None:
    source, attachments = observable_document_to_html(
        {
            "title": "Remote Plot",
            "nodes": [
                {
                    "id": 0,
                    "mode": "md",
                    "value": "md`# Remote Plot`",
                    "pinned": False,
                },
                {
                    "id": 3,
                    "mode": "js",
                    "value": 'data = FileAttachment("data.csv").csv()',
                    "pinned": True,
                },
            ],
            "files": [
                {
                    "name": "data.csv",
                    "download_url": "https://static.example/data.csv",
                    "mime_type": "text/csv",
                    "size": 12,
                    "create_time": "2026-05-24T10:00:00.000Z",
                }
            ],
        }
    )

    assert "<title>Remote Plot</title>" in source
    assert 'id="0"' in source
    assert 'type="application/vnd.observable.javascript"' in source
    assert 'pinned=""' in source
    assert attachments == {
        "data.csv": {
            "url": "https://static.example/data.csv",
            "mimeType": "text/csv",
            "size": 12,
            "lastModified": 1779616800000,
        }
    }


def test_notebook_from_observablehq_fetches_source_and_remote_attachments(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fake_fetch(
        url: str, *, timeout: float | None
    ) -> tuple[str, dict[str, dict[str, Any]]]:
        assert url == "https://observablehq.com/@d3/bar-chart"
        assert timeout == 1
        return (
            """<!doctype html>
<notebook>
  <title>Remote</title>
  <script id="1" type="application/vnd.observable.javascript">
    answer = 42
  </script>
</notebook>
""",
            {"data.csv": {"url": "https://static.example/data.csv"}},
        )

    monkeypatch.setattr(
        "pyobservablejs._notebook.fetch_observablehq_notebook", fake_fetch
    )

    widget = obs.Notebook.from_observablehq(
        "https://observablehq.com/@d3/bar-chart",
        timeout=1,
        attachments={"local.csv": "https://example.test/local.csv"},
        variables={"answer": 7},
    )

    assert widget.source.startswith("<!doctype html>")
    assert widget.attachments["data.csv"]["url"] == "https://static.example/data.csv"
    assert widget.attachments["local.csv"]["url"] == "https://example.test/local.csv"
    assert widget.variables == {"answer": 7}
    assert widget.get_state(["_variables"]) == {"_variables": {"answer": 7}}
    assert len(widget.cells) == 1


def test_notebook_serializes_source_cells() -> None:
    widget = obs.Notebook(
        obs.md("# Title"),
        obs.js("const answer = 42;", output="answer"),
        title="Demo",
    )

    assert widget.spec["title"] == "Demo"
    assert widget.spec["cells"][0]["mode"] == "md"
    assert widget.spec["cells"][1]["output"] == "answer"
    assert "<notebook" in widget.to_notebook_html()


def test_cell_defaults_to_observable_js_and_dedents() -> None:
    item = obs.ojs(
        """
        answer = 42
        """
    )

    assert item.mode == "ojs"
    assert item.source == "answer = 42"


def test_notebook_rejects_list_wrapped_cells() -> None:
    bad_cells: Any = [obs.ojs("answer = 42")]
    with pytest.raises(TypeError, match="strings or Cell objects"):
        obs.Notebook(bad_cells)


def test_notebook_composes_python_cells_as_named_child_widgets() -> None:
    widget = obs.Notebook(
        obs.md("# Title", name="title"),
        obs.ojs("answer = 42", name="answer"),
        title="Composed",
    )

    cell_refs = [f"anywidget:{item.model_id}" for item in widget.cells]
    assert len(widget.cells) == 2
    assert widget.cell("answer") is widget.cells[1]
    assert widget.get_state(["_cell_widgets"]) == {"_cell_widgets": cell_refs}
    assert widget.cells[0].role == "cell"
    assert widget.cells[0]._cell_id
    assert widget.cells[0]._cell_id != widget.cells[1]._cell_id
    assert widget.cells[0].name == "title"
    assert not widget.cells[0].has_trait("cell")
    assert widget.graph is None
    assert not widget.cells[0].has_trait("_info")
    assert widget.cells[0].info is None
    assert widget.cells[0]._values == {}
    assert widget.cells[0]._value_names == []


def test_bare_widgettrait_list_does_not_serialize_child_refs() -> None:
    class BareParent(anywidget.AnyWidget):
        _esm = "export default {}"
        children = traitlets.List(anywidget.WidgetTrait(), default_value=[]).tag(
            sync=True
        )

    widget = obs.Notebook(obs.ojs("answer = 42", name="answer"))
    bare = BareParent(children=[widget.cell("answer")])

    assert bare.get_state(["children"]) == {"children": [widget.cell("answer")]}
    assert widget.get_state(["_cell_widgets"]) == {
        "_cell_widgets": [f"anywidget:{widget.cell('answer').model_id}"]
    }


def test_notebook_rejects_invalid_cell_widget_overrides() -> None:
    class OtherWidget(anywidget.AnyWidget):
        _esm = "export default {}"

    widget = obs.Notebook(obs.ojs("answer = 42"))
    invalid_none: Any = [None]
    invalid_other: Any = [OtherWidget()]
    with pytest.raises(traitlets.TraitError, match="_cell_widgets"):
        widget.set_trait("_cell_widgets", invalid_none)

    with pytest.raises(traitlets.TraitError, match="_cell_widgets"):
        widget.set_trait("_cell_widgets", invalid_other)


def test_notebook_graph_exposes_symbolic_cell_metadata() -> None:
    widget = obs.Notebook(
        obs.ojs("a = 1", name="a"),
        obs.ojs("b = a + rows.length", name="b"),
        variables={"rows": [{"x": 1}]},
    )
    raw_graph = {
        "cells": [
            {
                "id": 1,
                "index": 0,
                "name": "a",
                "mode": "ojs",
                "defines": ["a"],
                "references": [],
                "output": "a",
                "outputs": [],
                "runtime_outputs": ["a"],
                "autodisplay": True,
                "autoview": False,
                "automutable": False,
            },
            {
                "id": 2,
                "index": 1,
                "name": "b",
                "mode": "ojs",
                "defines": ["b"],
                "references": ["a", "rows"],
                "output": "b",
                "outputs": [],
                "runtime_outputs": ["b"],
                "autodisplay": True,
                "autoview": False,
                "automutable": False,
            },
        ],
        "edges": [{"from": 1, "to": 2, "variable": "a"}],
    }
    widget.set_trait("_graph", raw_graph)

    graph = widget.graph

    assert isinstance(graph, NotebookGraph)
    assert graph.defines == ("a", "b")
    assert graph.references == ("a", "rows")
    assert graph.external_references == ("rows",)
    assert graph.edges == (DependencyEdge(source_id=1, target_id=2, variable="a"),)
    assert widget.cell("b").info == graph.cells[1]
    assert widget.cell("b").defines == ("b",)
    assert widget.cell("b").references == ("a", "rows")
    assert widget.cell("b").outputs == ()
    assert widget.cell("b").runtime_outputs == ("b",)
    assert widget.cell("b").output == "b"


def test_cell_lookup_can_use_unique_graph_output() -> None:
    widget = obs.Notebook(
        obs.ojs("answer = 42"),
        obs.ojs("answer + 1", name="readout"),
    )
    widget.set_trait(
        "_graph",
        {
            "cells": [
                {
                    "id": 1,
                    "index": 0,
                    "mode": "ojs",
                    "defines": ["answer"],
                    "references": [],
                    "output": "answer",
                    "runtime_outputs": ["answer"],
                }
            ],
            "edges": [],
        },
    )

    with pytest.raises(KeyError, match="Unknown Observable cell name"):
        widget.cell("answer")
    assert widget.cell_for_variable("answer") is widget.cells[0]


def test_cell_lookup_rejects_ambiguous_graph_variable() -> None:
    widget = obs.Notebook(
        obs.ojs("answer = 42"),
        obs.ojs("answer = 43"),
    )
    widget.set_trait(
        "_graph",
        {
            "cells": [
                {"id": 1, "index": 0, "mode": "ojs", "defines": ["answer"]},
                {"id": 2, "index": 1, "mode": "ojs", "defines": ["answer"]},
            ],
            "edges": [],
        },
    )

    with pytest.raises(KeyError, match="Ambiguous Observable variable"):
        widget.cell_for_variable("answer")


def test_cell_lookup_separates_python_name_from_ojs_variable() -> None:
    widget = obs.Notebook(
        obs.ojs("alpha = 1", name="conflict"),
        obs.ojs("conflict = 2", name="other"),
    )
    widget.set_trait(
        "_graph",
        {
            "cells": [
                {"id": 1, "index": 0, "mode": "ojs", "defines": ["alpha"]},
                {"id": 2, "index": 1, "mode": "ojs", "defines": ["conflict"]},
            ],
            "edges": [],
        },
    )

    assert widget.cell("conflict") is widget.cells[0]
    assert widget.cell_for_variable("conflict") is widget.cells[1]


def test_malformed_graph_entries_are_dropped() -> None:
    widget = obs.Notebook(obs.ojs("answer = 42"))
    widget.set_trait(
        "_graph",
        {
            "cells": [
                {"id": "1", "index": "0", "mode": "ojs", "defines": ["answer"]},
                {"id": "bad", "index": 1, "mode": "ojs", "defines": ["bad"]},
            ],
            "edges": [
                {"from": "1", "to": "2", "variable": "answer"},
                {"from": "bad", "to": 2, "variable": "bad"},
            ],
        },
    )

    graph = widget.graph

    assert graph is not None
    assert graph.cells == (
        CellInfo(
            id=1,
            index=0,
            mode="ojs",
            name=None,
            defines=("answer",),
            references=(),
            output=None,
            outputs=(),
            runtime_outputs=(),
            autodisplay=False,
            autoview=False,
            automutable=False,
        ),
    )
    assert graph.edges == (DependencyEdge(source_id=1, target_id=2, variable="answer"),)


def test_named_notebook_cells_expose_values() -> None:
    widget = obs.Notebook(obs.ojs("viewof gain = Inputs.range([0, 11])", name="gain"))
    cell_widget = widget.cell("gain")

    cell_widget._values = {"gain": 7}
    cell_widget._value_names = ["gain", "doubled"]

    assert cell_widget.value == 7
    assert cell_widget.values == {"gain": 7}
    assert widget.value("gain") == 7
    assert widget.values == {"gain": 7}


def test_cell_value_error_points_to_values_mapping() -> None:
    cell_widget = obs.Notebook(obs.ojs("answer = 42", name="cell")).cell("cell")
    cell_widget._values = {"answer": 42, "double": 84}

    with pytest.raises(KeyError, match=r"cell\.values\[name\]"):
        _ = cell_widget.value


def test_notebook_values_are_synced_trait_state() -> None:
    widget = obs.Notebook(obs.ojs("viewof gain = Inputs.range([0, 11])", name="gain"))
    changes: list[dict[str, object]] = []
    widget.observe(changes.append, names="_values")

    widget._values = {"gain": 8}
    widget._value_names = ["gain"]

    assert widget.values == {"gain": 8}
    assert widget.value("gain") == 8
    assert widget._value_names == ["gain"]
    assert changes[-1]["name"] == "_values"
    assert changes[-1]["new"] == {"gain": 8}


def test_script_end_tag_is_escaped() -> None:
    widget = obs.Notebook(obs.ojs("html`</script> </SCRIPT>`"))

    assert "<\\/script>" in widget.to_notebook_html()
    assert "</SCRIPT>" not in widget.to_notebook_html()


def test_notebook_serializes_python_variables() -> None:
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


def test_variables_updates_synced_wire_state() -> None:
    widget = obs.Notebook()

    widget.replace_variables({"py_value": 7})

    assert widget.variables == {"py_value": 7}
    assert widget.get_state(["_variables"]) == {"_variables": {"py_value": 7}}


def test_variables_update_merges_synced_wire_state() -> None:
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


def test_variable_replacement_and_reset_update_synced_wire_state() -> None:
    widget = obs.Notebook(variables={"gain": 5, "rows": [{"x": 1}]})

    widget.replace_variables({"rows": [{"x": 2}]})

    assert widget.variables == {"rows": [{"x": 2}]}
    assert widget.get_state(["_variable_update"])["_variable_update"] == {
        "seq": 1,
        "kind": "replace",
        "values": {"rows": [{"x": 2}]},
    }

    widget.update_variables(gain=7)
    widget.reset_variables("rows")

    assert widget.variables == {"gain": 7}
    assert widget.get_state(["_variable_update"])["_variable_update"] == {
        "seq": 3,
        "kind": "replace",
        "values": {"gain": 7},
    }


def test_browser_values_are_python_facing_with_wire_escape_hatch() -> None:
    widget = obs.Notebook()

    widget._values = {
        "when": {
            "__pyobservablejs_type__": "datetime",
            "value": "2026-05-25T10:00:00.000Z",
        },
        "raw": {"__pyobservablejs_type__": "arraybuffer", "value": "YWJj"},
    }

    assert widget.values["when"] == dt.datetime(2026, 5, 25, 10, tzinfo=dt.timezone.utc)
    assert widget.values["raw"] == b"abc"
    assert widget.wire_values["raw"] == {
        "__pyobservablejs_type__": "arraybuffer",
        "value": "YWJj",
    }


def test_invalid_python_var_name_raises() -> None:
    with pytest.raises(ValueError, match="Invalid Observable variable name"):
        obs.Notebook(variables={"not-valid": 1})


def test_python_variables_mapping_preserves_wire_type_key() -> None:
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
            assert orient == "records"
            return [{"x": 1}]

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


def test_from_html_embeds_file_attachments_and_local_imports(
    tmp_path: pathlib.Path,
) -> None:
    data = tmp_path / "data"
    data.mkdir()
    (data / "points.csv").write_text("x,y\n1,2\n", encoding="utf-8")
    (tmp_path / "helper.js").write_text("export const value = 1;\n", encoding="utf-8")
    notebook = tmp_path / "example.html"
    notebook.write_text(
        """<!doctype html>
<notebook>
  <title>Example</title>
  <script id="1" type="module">
    import {value} from "./helper.js";
    const points = FileAttachment("data/points.csv").csv();
    display(value);
  </script>
</notebook>
""",
        encoding="utf-8",
    )

    widget = _notebook_from_html_file(notebook)

    assert "data/points.csv" in widget.attachments
    assert widget.attachments["data/points.csv"]["url"].startswith(
        "data:text/csv;base64,"
    )
    assert 'from "data:text/javascript;base64,' in widget.source
    assert len(widget.cells) == 1
    assert widget.spec == {}


def test_from_html_requires_html_string(tmp_path: pathlib.Path) -> None:
    path = tmp_path / "chart.html"
    path.write_text("<notebook></notebook>", encoding="utf-8")
    bad_source: Any = path

    with pytest.raises(TypeError, match="HTML string"):
        obs.Notebook.from_html(bad_source)


def test_source_backed_notebook_creates_one_unique_notebook_cell_per_script() -> None:
    widget = obs.Notebook.from_html(
        """<!doctype html>
<notebook>
  <script id="10" type="text/markdown"># Title</script>
  <script id="11" type="module">const svg = ({node: () => "live"});</script>
  <script id="12" type="module">svg.node()</script>
</notebook>
""",
    )

    cell_refs = [f"anywidget:{item.model_id}" for item in widget.cells]

    assert len(widget.cells) == 3
    assert [widget.cell(index) for index in range(3)] == list(widget.cells)
    assert len({cell._cell_id for cell in widget.cells}) == 3
    assert widget.get_state(["_cell_widgets"]) == {"_cell_widgets": cell_refs}


def test_from_html_rewrites_only_javascript_imports(tmp_path: pathlib.Path) -> None:
    (tmp_path / "helper.js").write_text("export const value = 1;\n", encoding="utf-8")
    notebook = tmp_path / "example.html"
    notebook.write_text(
        """<!doctype html>
<notebook>
  <script id="1" type="text/markdown">
    Prose mentioning from "./helper.js" must remain text.
  </script>
  <script id="2" type="module">
    import "./helper.js";
    import /* side effect */ "./helper.js";
    import {value} from /* from */ "./helper.js";
    // import "./helper.js";
    const literal = 'import "./helper.js"';
    const dynamic = html`${import("./helper.js")}`;
    const dynamicWithComment = html`${import /* dynamic */ ("./helper.js")}`;
    const importPattern = /import\\("\\.\\/helper\\.js"\\)/;
  </script>
</notebook>
""",
        encoding="utf-8",
    )

    widget = _notebook_from_html_file(notebook)

    assert 'from "./helper.js"' in widget.source
    assert 'import "data:text/javascript;base64,' in widget.source
    assert 'import("data:text/javascript;base64,' in widget.source
    assert '// import "./helper.js";' in widget.source
    assert """const literal = 'import "./helper.js"';""" in widget.source
    assert r"""const importPattern = /import\("\.\/helper\.js"\)/;""" in widget.source
    assert widget.source.count("data:text/javascript;base64,") == 5
    assert len(widget.cells) == 2


def test_from_html_does_not_rewrite_import_named_methods(
    tmp_path: pathlib.Path,
) -> None:
    (tmp_path / "helper.js").write_text("export const value = 1;\n", encoding="utf-8")
    notebook = tmp_path / "example.html"
    notebook.write_text(
        """<!doctype html>
<notebook>
  <script id="1" type="module">
    const method = obj.import("./helper.js");
    const optional = obj?.import("./helper.js");
    const privateMethod = this.#import("./helper.js");
    const real = import("./helper.js");
  </script>
</notebook>
""",
        encoding="utf-8",
    )

    widget = _notebook_from_html_file(notebook)

    assert 'obj.import("./helper.js")' in widget.source
    assert 'obj?.import("./helper.js")' in widget.source
    assert 'this.#import("./helper.js")' in widget.source
    assert widget.source.count("data:text/javascript;base64,") == 1


def test_from_html_allows_comments_between_file_attachment_tokens(
    tmp_path: pathlib.Path,
) -> None:
    (tmp_path / "data.csv").write_text("x,y\n1,2\n", encoding="utf-8")
    notebook = tmp_path / "example.html"
    notebook.write_text(
        """<!doctype html>
<notebook>
  <script id="1" type="module">
    const a = FileAttachment /* block */ ("data.csv").csv();
    const b = FileAttachment // line
      ("data.csv").csv();
  </script>
</notebook>
""",
        encoding="utf-8",
    )

    widget = _notebook_from_html_file(notebook)

    assert set(widget.attachments) == {"data.csv"}


def test_from_html_embeds_only_standalone_file_attachment_calls(
    tmp_path: pathlib.Path,
) -> None:
    (tmp_path / "data.csv").write_text("x,y\n1,2\n", encoding="utf-8")
    (tmp_path / "secret.csv").write_text("x,y\n9,9\n", encoding="utf-8")
    notebook = tmp_path / "example.html"
    notebook.write_text(
        """<!doctype html>
<notebook>
  <script id="1" type="module">
    obj.FileAttachment("secret.csv");
    obj?.FileAttachment("secret.csv");
    this.#FileAttachment("secret.csv");
    $FileAttachment("secret.csv");
    FileAttachment("data.csv");
  </script>
</notebook>
""",
        encoding="utf-8",
    )

    widget = _notebook_from_html_file(notebook)

    assert set(widget.attachments) == {"data.csv"}


def test_from_html_embeds_only_executable_file_attachments(
    tmp_path: pathlib.Path,
) -> None:
    (tmp_path / "points.csv").write_text("x,y\n1,2\n", encoding="utf-8")
    (tmp_path / "secret.csv").write_text("x,y\n9,9\n", encoding="utf-8")
    notebook = tmp_path / "example.html"
    notebook.write_text(
        """<!doctype html>
<notebook>
  <script id="1" type="text/markdown">
    Prose mentioning FileAttachment("secret.csv") must not embed it.
  </script>
  <script id="2" type="module">
    // FileAttachment("secret.csv")
    const literal = 'FileAttachment("secret.csv")';
    const attachmentPattern = /FileAttachment\\("secret.csv"\\)/;
    const slash = "//";
    function pattern() { return /FileAttachment\\("secret.csv"\\)/; }
    function sameLine() { const s = "//"; return /FileAttachment\\("secret.csv"\\)/; }
    function fail() { throw /FileAttachment\\("secret.csv"\\)/; }
    function blockComment() { return /* c */ /FileAttachment\\("secret.csv"\\)/; }
    function lineComment() { throw // c
      /FileAttachment\\("secret.csv"\\)/; }
    if (false) /FileAttachment("secret.csv")/.test("x");
    while (false) /FileAttachment("secret.csv")/.test("x");
    for (; false;) /FileAttachment("secret.csv")/.test("x");
    with ({}) /FileAttachment("secret.csv")/.test("x");
    async function f(xs) {
      for await (const x of xs) /FileAttachment("secret.csv")/.test(x);
    }
    if (false) {} else /FileAttachment\\("secret.csv"\\)/.test("x");
    do /FileAttachment\\("secret.csv"\\)/.test("x"); while (false);
    for (const x of /FileAttachment\\("secret.csv"\\)/) {}
    if ("x" in /FileAttachment\\("secret.csv"\\)/) {}
    if ("x" instanceof /FileAttachment\\("secret.csv"\\)/) {}
    const image = html`<img src=${FileAttachment("points.csv").url()}>`;
    const points = FileAttachment("points.csv").csv();
  </script>
</notebook>
""",
        encoding="utf-8",
    )

    widget = _notebook_from_html_file(notebook)

    assert set(widget.attachments) == {"points.csv"}
    assert widget.attachments["points.csv"]["url"].startswith("data:text/csv;base64,")


def test_from_html_keeps_method_calls_before_division_executable(
    tmp_path: pathlib.Path,
) -> None:
    (tmp_path / "data.csv").write_text("x,y\n1,2\n", encoding="utf-8")
    notebook = tmp_path / "example.html"
    notebook.write_text(
        """<!doctype html>
<notebook>
  <script id="1" type="module">
    promise.catch(handler) / FileAttachment("data.csv").size;
  </script>
</notebook>
""",
        encoding="utf-8",
    )

    widget = _notebook_from_html_file(notebook)

    assert set(widget.attachments) == {"data.csv"}


def test_from_html_keeps_property_names_before_division_executable(
    tmp_path: pathlib.Path,
) -> None:
    (tmp_path / "data.csv").write_text("x,y\n1,2\n", encoding="utf-8")
    notebook = tmp_path / "example.html"
    notebook.write_text(
        """<!doctype html>
<notebook>
  <script id="1" type="module">
    obj.return / FileAttachment("data.csv").size;
    obj.await / FileAttachment("data.csv").size;
  </script>
</notebook>
""",
        encoding="utf-8",
    )

    widget = _notebook_from_html_file(notebook)

    assert set(widget.attachments) == {"data.csv"}


def test_from_html_keeps_private_names_before_division_executable(
    tmp_path: pathlib.Path,
) -> None:
    (tmp_path / "data.csv").write_text("x,y\n1,2\n", encoding="utf-8")
    notebook = tmp_path / "example.html"
    notebook.write_text(
        """<!doctype html>
<notebook>
  <script id="1" type="module">
    this.#return / FileAttachment("data.csv").size;
    this.#catch(handler) / FileAttachment("data.csv").size;
  </script>
</notebook>
""",
        encoding="utf-8",
    )

    widget = _notebook_from_html_file(notebook)

    assert set(widget.attachments) == {"data.csv"}


def test_from_html_respects_unquoted_script_types(tmp_path: pathlib.Path) -> None:
    (tmp_path / "helper.js").write_text("export const value = 1;\n", encoding="utf-8")
    (tmp_path / "points.csv").write_text("x,y\n1,2\n", encoding="utf-8")
    (tmp_path / "secret.csv").write_text("x,y\n9,9\n", encoding="utf-8")
    notebook = tmp_path / "example.html"
    notebook.write_text(
        """<!doctype html>
<notebook>
  <script id="1" type=text/markdown>
    import "./helper.js"
    FileAttachment("secret.csv")
  </script>
  <script id="2" type=module>
    import "./helper.js";
    FileAttachment("points.csv");
  </script>
</notebook>
""",
        encoding="utf-8",
    )

    widget = _notebook_from_html_file(notebook)

    assert 'import "./helper.js"' in widget.source
    assert 'import "data:text/javascript;base64,' in widget.source
    assert set(widget.attachments) == {"points.csv"}


def test_from_html_ignores_data_type_when_script_type_is_absent(
    tmp_path: pathlib.Path,
) -> None:
    (tmp_path / "helper.js").write_text("export const value = 1;\n", encoding="utf-8")
    (tmp_path / "points.csv").write_text("x,y\n1,2\n", encoding="utf-8")
    notebook = tmp_path / "example.html"
    notebook.write_text(
        """<!doctype html>
<notebook>
  <script id="1" data-type="text/markdown">
    import "./helper.js";
    FileAttachment("points.csv");
  </script>
  <script id="2" data-note=" type=text/markdown ">
    import "./helper.js";
    FileAttachment("points.csv");
  </script>
</notebook>
""",
        encoding="utf-8",
    )

    widget = _notebook_from_html_file(notebook)

    assert 'import "data:text/javascript;base64,' in widget.source
    assert set(widget.attachments) == {"points.csv"}


def test_from_html_handles_gt_in_script_attribute_values(
    tmp_path: pathlib.Path,
) -> None:
    (tmp_path / "helper.js").write_text("export const value = 1;\n", encoding="utf-8")
    (tmp_path / "points.csv").write_text("x,y\n1,2\n", encoding="utf-8")
    notebook = tmp_path / "example.html"
    notebook.write_text(
        """<!doctype html>
<notebook>
  <script id="1" data-note=">">
    import "./helper.js";
    FileAttachment("points.csv");
  </script>
</notebook>
""",
        encoding="utf-8",
    )

    widget = _notebook_from_html_file(notebook)

    assert 'import "data:text/javascript;base64,' in widget.source
    assert set(widget.attachments) == {"points.csv"}


def test_from_html_ignores_scripts_outside_notebook(tmp_path: pathlib.Path) -> None:
    (tmp_path / "helper.js").write_text("export const value = 1;\n", encoding="utf-8")
    (tmp_path / "secret.csv").write_text("x,y\n9,9\n", encoding="utf-8")
    notebook = tmp_path / "example.html"
    notebook.write_text(
        """<!doctype html>
<script type="module">
  import "./helper.js";
  FileAttachment("secret.csv");
</script>
<notebook>
  <script id="1" type="text/markdown">
    import "./helper.js";
  </script>
</notebook>
""",
        encoding="utf-8",
    )

    widget = _notebook_from_html_file(notebook)

    assert 'import "./helper.js";' in widget.source
    assert widget.source.count('import "./helper.js";') == 2
    assert widget.attachments == {}


def test_from_html_ignores_script_tags_inside_html_comments(
    tmp_path: pathlib.Path,
) -> None:
    (tmp_path / "helper.js").write_text("export const value = 1;\n", encoding="utf-8")
    (tmp_path / "secret.csv").write_text("x,y\n9,9\n", encoding="utf-8")
    notebook = tmp_path / "example.html"
    notebook.write_text(
        """<!doctype html>
<notebook>
  <!--
  <script id="commented" type="module">
    import "./helper.js";
    FileAttachment("secret.csv");
  </script>
  -->
  <script id="real">
    const value = 1;
  </script>
</notebook>
""",
        encoding="utf-8",
    )

    widget = _notebook_from_html_file(notebook)

    assert 'import "./helper.js";' in widget.source
    assert "data:text/javascript;base64," not in widget.source
    assert widget.attachments == {}


def test_from_html_ignores_longer_closing_tag_prefixes(
    tmp_path: pathlib.Path,
) -> None:
    (tmp_path / "helper.js").write_text("export const value = 1;\n", encoding="utf-8")
    (tmp_path / "points.csv").write_text("x,y\n1,2\n", encoding="utf-8")
    notebook = tmp_path / "example.html"
    notebook.write_text(
        """<!doctype html>
<notebook>
  <script id="1">
    const tag = "</scripture>";
    import "./helper.js";
    FileAttachment("points.csv");
  </script>
</notebook>
""",
        encoding="utf-8",
    )

    widget = _notebook_from_html_file(notebook)

    assert 'import "data:text/javascript;base64,' in widget.source
    assert set(widget.attachments) == {"points.csv"}


def test_from_html_ignores_notebook_close_text_inside_script(
    tmp_path: pathlib.Path,
) -> None:
    (tmp_path / "helper.js").write_text("export const value = 1;\n", encoding="utf-8")
    (tmp_path / "points.csv").write_text("x,y\n1,2\n", encoding="utf-8")
    notebook = tmp_path / "example.html"
    notebook.write_text(
        """<!doctype html>
<notebook>
  <script id="1">
    const tag = "</notebook>";
    import "./helper.js";
    FileAttachment("points.csv");
  </script>
</notebook>
""",
        encoding="utf-8",
    )

    widget = _notebook_from_html_file(notebook)

    assert 'import "data:text/javascript;base64,' in widget.source
    assert set(widget.attachments) == {"points.csv"}


def test_from_html_treats_unknown_script_type_as_javascript() -> None:
    widget = obs.Notebook.from_html(
        """<!doctype html>
<notebook>
  <script id="1" type="text/javascript">
    const value = 1;
  </script>
</notebook>
"""
    )

    assert len(widget.cells) == 1


def test_from_html_rewrites_unknown_script_type_as_javascript(
    tmp_path: pathlib.Path,
) -> None:
    (tmp_path / "helper.js").write_text("export const value = 1;\n", encoding="utf-8")
    (tmp_path / "points.csv").write_text("x,y\n1,2\n", encoding="utf-8")
    notebook = tmp_path / "example.html"
    notebook.write_text(
        """<!doctype html>
<notebook>
  <script id="1" type="text/custom">
    import "./helper.js";
    FileAttachment("points.csv");
  </script>
</notebook>
""",
        encoding="utf-8",
    )

    widget = _notebook_from_html_file(notebook)

    assert 'import "data:text/javascript;base64,' in widget.source
    assert set(widget.attachments) == {"points.csv"}


def test_from_html_rewrites_minified_static_imports(tmp_path: pathlib.Path) -> None:
    (tmp_path / "helper.js").write_text("export const value = 1;\n", encoding="utf-8")
    notebook = tmp_path / "example.html"
    notebook.write_text(
        """<!doctype html>
<notebook>
  <script id="1" type="module">
    import{value}from"./helper.js";
    export{value}from"./helper.js";
  </script>
</notebook>
""",
        encoding="utf-8",
    )

    widget = _notebook_from_html_file(notebook)

    assert 'from"data:text/javascript;base64,' in widget.source
    assert widget.source.count("data:text/javascript;base64,") == 2
