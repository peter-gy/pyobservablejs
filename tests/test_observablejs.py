from __future__ import annotations

import datetime as dt
import pathlib
from typing import Any

import observablejs as ojs
import pytest


def test_public_namespace_is_small() -> None:
    assert set(ojs.__all__) == {
        "Cell",
        "Notebook",
        "arrow",
        "cell",
        "html",
        "md",
        "module",
        "records",
        "sql",
    }


def test_notebook_serializes_source_cells() -> None:
    widget = ojs.Notebook(
        ojs.md("# Title"),
        ojs.module("const answer = 42;", attrs={"output": "answer"}),
        title="Demo",
    )

    assert widget.spec["title"] == "Demo"
    assert widget.spec["cells"][0]["mode"] == "md"
    assert widget.spec["cells"][1]["output"] == "answer"
    assert "<notebook" in widget.to_notebook_html()


def test_cell_defaults_to_observable_js_and_dedents() -> None:
    item = ojs.cell(
        """
        answer = 42
        """
    )

    assert item.mode == "ojs"
    assert item.source == "answer = 42"


def test_notebook_rejects_list_wrapped_cells() -> None:
    bad_cells: Any = [ojs.cell("answer = 42")]
    with pytest.raises(TypeError, match="strings or Cell objects"):
        ojs.Notebook(bad_cells)


def test_notebook_composes_python_cells_as_named_child_widgets() -> None:
    widget = ojs.Notebook(
        ojs.md("# Title", name="title"),
        ojs.cell("answer = 42", name="answer"),
        title="Composed",
    )

    cell_refs = [f"anywidget:{item.model_id}" for item in widget.cells]
    assert len(widget.cells) == 2
    assert widget.cell("answer") is widget.cells[1]
    assert widget.get_state(["_cell_widgets"]) == {"_cell_widgets": cell_refs}
    assert widget.cells[0].role == "cell"
    assert widget.cells[0].name == "title"
    assert not widget.cells[0].has_trait("cell")
    assert widget.cells[0].variables == {}
    assert widget.cells[0].variable_names == []


def test_named_cell_handles_expose_values() -> None:
    widget = ojs.Notebook(ojs.cell("viewof gain = Inputs.range([0, 11])", name="gain"))
    cell_widget = widget.cell("gain")

    cell_widget.variables = {"gain": 7}
    cell_widget.variable_names = ["gain", "doubled"]

    assert cell_widget.value == 7
    assert cell_widget.values == {"gain": 7}
    assert widget.value("gain") == 7
    assert widget.values == {"gain": 7}


def test_script_end_tag_is_escaped() -> None:
    widget = ojs.Notebook(ojs.cell("html`</script> </SCRIPT>`"))

    assert "<\\/script>" in widget.to_notebook_html()
    assert "</SCRIPT>" not in widget.to_notebook_html()


def test_notebook_serializes_python_data() -> None:
    widget = ojs.Notebook(
        ojs.cell("py_answer + rows.length"),
        data={
            "py_answer": 42,
            "rows": [{"date": dt.date(2026, 5, 23), "value": float("nan")}],
            "raw": b"abc",
            "span": range(3),
        },
    )

    wire = widget.get_state(["_data"])["_data"]
    assert widget.data["rows"][0]["date"] == dt.date(2026, 5, 23)
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


def test_data_updates_synced_wire_state() -> None:
    widget = ojs.Notebook()

    widget.data = {"py_value": 7}

    assert widget.data == {"py_value": 7}
    assert widget.get_state(["_data"]) == {"_data": {"py_value": 7}}


def test_invalid_python_data_name_raises() -> None:
    with pytest.raises(ValueError, match="Invalid Observable variable name"):
        ojs.Notebook(data={"not-valid": 1})


def test_python_data_mapping_preserves_wire_type_key() -> None:
    widget = ojs.Notebook(
        data={"row": {"__observablejs_type__": "not-a-wire-tag", "value": 1}}
    )

    assert widget.get_state(["_data"])["_data"]["row"] == {
        "__observablejs_type__": "object",
        "value": {"__observablejs_type__": "not-a-wire-tag", "value": 1},
    }


def test_dataframe_like_values_serialize_as_records_by_default() -> None:
    class DataFrame:
        __module__ = "pandas"

        def to_dict(self, orient: str) -> list[dict[str, int]]:
            assert orient == "records"
            return [{"x": 1}]

    widget = ojs.Notebook(data={"rows": DataFrame()})

    assert widget.get_state(["_data"])["_data"]["rows"] == [{"x": 1}]


def test_records_helper_makes_record_conversion_explicit() -> None:
    class DataFrame:
        __module__ = "pandas"

        def to_dict(self, orient: str) -> list[dict[str, int]]:
            assert orient == "records"
            return [{"x": 1}]

    widget = ojs.Notebook(data={"rows": ojs.records(DataFrame())})

    assert widget.get_state(["_data"])["_data"]["rows"] == [{"x": 1}]


def test_from_file_embeds_file_attachments_and_local_imports(
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

    widget = ojs.Notebook.from_file(notebook)

    assert "data/points.csv" in widget.attachments
    assert widget.attachments["data/points.csv"]["url"].startswith(
        "data:text/csv;base64,"
    )
    assert 'from "data:text/javascript;base64,' in widget.source
    assert len(widget.cells) == 1
    assert widget.spec == {}


def test_from_file_rewrites_only_javascript_imports(tmp_path: pathlib.Path) -> None:
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

    widget = ojs.Notebook.from_file(notebook)

    assert 'from "./helper.js"' in widget.source
    assert 'import "data:text/javascript;base64,' in widget.source
    assert 'import("data:text/javascript;base64,' in widget.source
    assert '// import "./helper.js";' in widget.source
    assert """const literal = 'import "./helper.js"';""" in widget.source
    assert r"""const importPattern = /import\("\.\/helper\.js"\)/;""" in widget.source
    assert widget.source.count("data:text/javascript;base64,") == 5
    assert len(widget.cells) == 2


def test_from_file_does_not_rewrite_import_named_methods(
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

    widget = ojs.Notebook.from_file(notebook)

    assert 'obj.import("./helper.js")' in widget.source
    assert 'obj?.import("./helper.js")' in widget.source
    assert 'this.#import("./helper.js")' in widget.source
    assert widget.source.count("data:text/javascript;base64,") == 1


def test_from_file_allows_comments_between_file_attachment_tokens(
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

    widget = ojs.Notebook.from_file(notebook)

    assert set(widget.attachments) == {"data.csv"}


def test_from_file_embeds_only_standalone_file_attachment_calls(
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

    widget = ojs.Notebook.from_file(notebook)

    assert set(widget.attachments) == {"data.csv"}


def test_from_file_embeds_only_executable_file_attachments(
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

    widget = ojs.Notebook.from_file(notebook)

    assert set(widget.attachments) == {"points.csv"}
    assert widget.attachments["points.csv"]["url"].startswith("data:text/csv;base64,")


def test_from_file_keeps_method_calls_before_division_executable(
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

    widget = ojs.Notebook.from_file(notebook)

    assert set(widget.attachments) == {"data.csv"}


def test_from_file_keeps_property_names_before_division_executable(
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

    widget = ojs.Notebook.from_file(notebook)

    assert set(widget.attachments) == {"data.csv"}


def test_from_file_keeps_private_names_before_division_executable(
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

    widget = ojs.Notebook.from_file(notebook)

    assert set(widget.attachments) == {"data.csv"}


def test_from_file_respects_unquoted_script_types(tmp_path: pathlib.Path) -> None:
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

    widget = ojs.Notebook.from_file(notebook)

    assert 'import "./helper.js"' in widget.source
    assert 'import "data:text/javascript;base64,' in widget.source
    assert set(widget.attachments) == {"points.csv"}


def test_from_file_ignores_data_type_when_script_type_is_absent(
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

    widget = ojs.Notebook.from_file(notebook)

    assert 'import "data:text/javascript;base64,' in widget.source
    assert set(widget.attachments) == {"points.csv"}


def test_from_file_handles_gt_in_script_attribute_values(
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

    widget = ojs.Notebook.from_file(notebook)

    assert 'import "data:text/javascript;base64,' in widget.source
    assert set(widget.attachments) == {"points.csv"}


def test_from_file_ignores_scripts_outside_notebook(tmp_path: pathlib.Path) -> None:
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

    widget = ojs.Notebook.from_file(notebook)

    assert 'import "./helper.js";' in widget.source
    assert widget.source.count('import "./helper.js";') == 2
    assert widget.attachments == {}


def test_from_file_ignores_script_tags_inside_html_comments(
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

    widget = ojs.Notebook.from_file(notebook)

    assert 'import "./helper.js";' in widget.source
    assert "data:text/javascript;base64," not in widget.source
    assert widget.attachments == {}


def test_from_file_ignores_longer_closing_tag_prefixes(
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

    widget = ojs.Notebook.from_file(notebook)

    assert 'import "data:text/javascript;base64,' in widget.source
    assert set(widget.attachments) == {"points.csv"}


def test_from_file_ignores_notebook_close_text_inside_script(
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

    widget = ojs.Notebook.from_file(notebook)

    assert 'import "data:text/javascript;base64,' in widget.source
    assert set(widget.attachments) == {"points.csv"}


def test_from_html_treats_unknown_script_type_as_javascript() -> None:
    widget = ojs.Notebook.from_html(
        """<!doctype html>
<notebook>
  <script id="1" type="text/javascript">
    const value = 1;
  </script>
</notebook>
"""
    )

    assert len(widget.cells) == 1


def test_from_file_rewrites_unknown_script_type_as_javascript(
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

    widget = ojs.Notebook.from_file(notebook)

    assert 'import "data:text/javascript;base64,' in widget.source
    assert set(widget.attachments) == {"points.csv"}


def test_from_file_rewrites_minified_static_imports(tmp_path: pathlib.Path) -> None:
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

    widget = ojs.Notebook.from_file(notebook)

    assert 'from"data:text/javascript;base64,' in widget.source
    assert widget.source.count("data:text/javascript;base64,") == 2
