from __future__ import annotations

import datetime as dt
import inspect
import pathlib
import sys
import textwrap
import types
from collections.abc import Sequence
from typing import Any, cast

import pyobservablejs as obs
import pytest
from pyobservablejs._chunked_anywidget import (
    ChunkedAnyWidget,
    ChunkedAnyWidgetFrontend,
)
from helpers import (
    BrowserGraphCellBuilder,
    BrowserGraphSync,
    BrowserValueSync,
    CommentNodes,
    DocumentTitle,
    JavaScriptImport,
    ObservableHQResponseInstaller,
    ScriptTags,
    decode_data_url,
    javascript_imports,
    javascript_import_specifiers,
)

ExpectedImport = tuple[str, bytes, tuple[str, ...], tuple[str, ...]]


def _notebook_from_html_file(path: pathlib.Path, **kwargs: Any) -> obs.Notebook:
    return obs.Notebook.from_html(
        path.read_text(encoding="utf-8"),
        base_path=path.parent,
        **kwargs,
    )


def _widget_class_for_static_dir(static_dir: pathlib.Path) -> type[ChunkedAnyWidget]:
    static_dir.mkdir(parents=True, exist_ok=True)
    (static_dir / "index.js").write_text(
        "export default { render() {} };",
        encoding="utf-8",
    )
    (static_dir / "widget.css").write_text("", encoding="utf-8")
    frontend = ChunkedAnyWidgetFrontend(static_dir=static_dir)

    class StaticWidget(ChunkedAnyWidget):
        _frontend = frontend
        _esm, _css = frontend.anywidget_assets()

    return StaticWidget


def _traitlet_module_response(
    widget: ChunkedAnyWidget, module_path: str, *, seq: int = 1
) -> dict[str, object]:
    widget.set_trait("_esm_module_request", {"seq": seq, "path": module_path})
    return cast(dict[str, object], getattr(widget, "_esm_module_response"))


def _command_module_response(
    widget: ChunkedAnyWidget, module_path: str
) -> dict[str, object]:
    response, buffers = widget.read_esm_module({"path": module_path}, [])
    assert buffers == []
    return response


def _script_by_id(scripts: list[dict[str, Any]], script_id: str) -> dict[str, Any]:
    matches = [script for script in scripts if script["attrs"].get("id") == script_id]
    assert len(matches) == 1
    return matches[0]


def _assert_javascript_import_payloads(
    source: str,
    expected_imports: Sequence[ExpectedImport],
) -> None:
    actual_imports = _decoded_data_imports(javascript_imports(source))
    assert actual_imports == [
        _expected_import_payload(expected) for expected in expected_imports
    ]
    _assert_no_relative_javascript_import_specifiers(source)


def _assert_no_relative_javascript_import_specifiers(source: str) -> None:
    assert [
        specifier
        for specifier in javascript_import_specifiers(source)
        if specifier.startswith(("./", "../"))
    ] == []


def _decoded_data_imports(
    records: Sequence[JavaScriptImport],
) -> list[tuple[str, str, bytes, tuple[str, ...], tuple[str, ...]]]:
    return [
        (record.kind, mime_type, payload, record.imported, record.exported)
        for record in records
        if record.specifier.startswith("data:")
        for mime_type, payload in [decode_data_url(record.specifier)]
    ]


def _expected_import_payload(
    item: ExpectedImport,
) -> tuple[str, str, bytes, tuple[str, ...], tuple[str, ...]]:
    kind, payload, imported, exported = item
    return (kind, "text/javascript", payload, imported, exported)


def _normalized_source(source: str) -> str:
    return textwrap.dedent(source).strip()


def _normalized_source_with_embedded_imports(source: str) -> str:
    normalized = source
    for specifier in javascript_import_specifiers(source):
        if specifier.startswith("data:"):
            normalized = normalized.replace(specifier, "<embedded>")
    return _normalized_source(normalized)


def _line_indent(source: str, text: str) -> int:
    matches = [line for line in source.splitlines() if line.strip() == text]
    assert len(matches) == 1
    return len(matches[0]) - len(matches[0].lstrip(" "))


def test_chunked_anywidget_frontend_returns_static_assets(
    tmp_path: pathlib.Path,
) -> None:
    frontend = ChunkedAnyWidgetFrontend(static_dir=tmp_path)

    esm, css = frontend.anywidget_assets()

    assert esm == tmp_path / "index.js"
    assert css == tmp_path / "widget.css"


def test_chunked_anywidget_frontend_uses_dev_server_module(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: pathlib.Path,
) -> None:
    frontend = ChunkedAnyWidgetFrontend(
        static_dir=tmp_path,
        dev_server_env="PYOBSERVABLEJS_DEV_SERVER",
        dev_module="js/widget/dev.ts?anywidget",
    )
    monkeypatch.setenv("PYOBSERVABLEJS_DEV_SERVER", "127.0.0.1:5173/")

    esm, css = frontend.anywidget_assets()

    assert esm == "http://127.0.0.1:5173/js/widget/dev.ts?anywidget"
    assert css == ""


def test_chunked_anywidget_serves_chunk_source_over_traitlet_and_command(
    tmp_path: pathlib.Path,
) -> None:
    static_dir = tmp_path / "static"
    chunk = static_dir / "chunks" / "app.js"
    chunk.parent.mkdir(parents=True)
    chunk.write_text("export default { render() {} };", encoding="utf-8")

    widget = _widget_class_for_static_dir(static_dir)()

    response = _traitlet_module_response(widget, "chunks/app.js")
    command_response = _command_module_response(widget, "chunks/app.js")

    assert response["seq"] == 1
    assert response["path"] == "chunks/app.js"
    assert response.get("source") == "export default { render() {} };"
    assert command_response["path"] == "chunks/app.js"
    assert command_response.get("source") == "export default { render() {} };"


def test_chunked_anywidget_reports_missing_chunks_over_traitlet_and_command(
    tmp_path: pathlib.Path,
) -> None:
    widget = _widget_class_for_static_dir(tmp_path / "static")()

    missing = _traitlet_module_response(widget, "chunks/missing.js")
    command_missing = _command_module_response(widget, "chunks/missing.js")

    assert missing["seq"] == 1
    assert missing["path"] == "chunks/missing.js"
    assert "source" not in missing
    assert "FileNotFoundError" in str(missing.get("error"))
    assert command_missing["path"] == "chunks/missing.js"
    assert "source" not in command_missing
    assert "FileNotFoundError" in str(command_missing.get("error"))


@pytest.mark.parametrize(
    "module_path",
    [
        "index.js",
        "/chunks/app.js",
        "chunks/../index.js",
        "chunks/app.css",
    ],
)
def test_chunked_anywidget_rejects_paths_outside_static_chunks(
    tmp_path: pathlib.Path,
    module_path: str,
) -> None:
    static_dir = tmp_path / "static"
    chunk = static_dir / "chunks" / "app.js"
    chunk.parent.mkdir(parents=True)
    chunk.write_text("export default { render() {} };", encoding="utf-8")

    widget = _widget_class_for_static_dir(static_dir)()

    response = _traitlet_module_response(widget, module_path)
    command_response = _command_module_response(widget, module_path)

    assert response["path"] == module_path
    assert "source" not in response
    assert "unsupported widget module path" in str(response.get("error"))
    assert command_response["path"] == module_path
    assert "source" not in command_response
    assert "unsupported widget module path" in str(command_response.get("error"))


def test_chunked_anywidget_rejects_symlink_escape(
    tmp_path: pathlib.Path,
) -> None:
    static_dir = tmp_path / "static"
    chunk_dir = static_dir / "chunks"
    chunk_dir.mkdir(parents=True)
    outside = tmp_path / "outside.js"
    outside.write_text("export default { render() {} };", encoding="utf-8")
    escape = chunk_dir / "escape.js"
    try:
        escape.symlink_to(outside)
    except (OSError, NotImplementedError) as error:
        pytest.skip(f"symlinks are unavailable: {error}")

    widget = _widget_class_for_static_dir(static_dir)()

    response = _traitlet_module_response(widget, "chunks/escape.js")
    command_response = _command_module_response(widget, "chunks/escape.js")

    assert response["path"] == "chunks/escape.js"
    assert "source" not in response
    assert "unsupported widget module path" in str(response.get("error"))
    assert command_response["path"] == "chunks/escape.js"
    assert "source" not in command_response
    assert "unsupported widget module path" in str(command_response.get("error"))


def test_public_namespace_is_small() -> None:
    expected_public = {"NOTEBOOK_THEMES", "Notebook", "html", "js", "md", "ojs"}
    assert set(obs.__all__) == expected_public
    assert {name for name in dir(obs) if not name.startswith("_")} == expected_public

    namespace: dict[str, object] = {}
    exec("from pyobservablejs import *", namespace)

    assert {name for name in namespace if not name.startswith("_")} == expected_public


def test_notebook_themes_match_notebook_kit_theme_names() -> None:
    assert obs.NOTEBOOK_THEMES == (
        "air",
        "coffee",
        "cotton",
        "deep-space",
        "glacier",
        "ink",
        "midnight",
        "near-midnight",
        "ocean-floor",
        "parchment",
        "slate",
        "stark",
        "sun-faded",
    )


def test_public_api_signatures_keep_keyword_only_options() -> None:
    assert [
        (name, param.kind)
        for name, param in inspect.signature(obs.Notebook).parameters.items()
    ] == [
        ("cells", inspect.Parameter.VAR_POSITIONAL),
        ("title", inspect.Parameter.KEYWORD_ONLY),
        ("theme", inspect.Parameter.KEYWORD_ONLY),
        ("mode", inspect.Parameter.KEYWORD_ONLY),
        ("attachments", inspect.Parameter.KEYWORD_ONLY),
        ("base_path", inspect.Parameter.KEYWORD_ONLY),
        ("variables", inspect.Parameter.KEYWORD_ONLY),
        ("show_pinned_source", inspect.Parameter.KEYWORD_ONLY),
    ]
    assert [
        (name, param.kind)
        for name, param in inspect.signature(obs.Notebook.from_html).parameters.items()
    ] == [
        ("source", inspect.Parameter.POSITIONAL_OR_KEYWORD),
        ("attachments", inspect.Parameter.KEYWORD_ONLY),
        ("base_path", inspect.Parameter.KEYWORD_ONLY),
        ("portable", inspect.Parameter.KEYWORD_ONLY),
        ("variables", inspect.Parameter.KEYWORD_ONLY),
        ("show_pinned_source", inspect.Parameter.KEYWORD_ONLY),
    ]
    assert [
        (name, param.kind)
        for name, param in inspect.signature(
            obs.Notebook.from_observablehq
        ).parameters.items()
    ] == [
        ("specifier", inspect.Parameter.POSITIONAL_OR_KEYWORD),
        ("variables", inspect.Parameter.KEYWORD_ONLY),
        ("attachments", inspect.Parameter.KEYWORD_ONLY),
        ("show_pinned_source", inspect.Parameter.KEYWORD_ONLY),
        ("timeout", inspect.Parameter.KEYWORD_ONLY),
    ]
    for helper in (obs.ojs, obs.js, obs.md, obs.html):
        assert [
            (name, param.kind)
            for name, param in inspect.signature(helper).parameters.items()
        ] == [
            ("source", inspect.Parameter.POSITIONAL_OR_KEYWORD),
            ("name", inspect.Parameter.KEYWORD_ONLY),
            ("display", inspect.Parameter.KEYWORD_ONLY),
            ("raw", inspect.Parameter.KEYWORD_ONLY),
            ("id", inspect.Parameter.KEYWORD_ONLY),
            ("pinned", inspect.Parameter.KEYWORD_ONLY),
            ("output", inspect.Parameter.KEYWORD_ONLY),
            ("attrs", inspect.Parameter.KEYWORD_ONLY),
        ]


def test_cell_options_serialize_to_notebook_html(
    script_tags: ScriptTags,
    document_title: DocumentTitle,
) -> None:
    cell = obs.ojs(
        "answer = 42",
        name="answer",
        display=False,
        id=7,
        pinned=True,
        output="answer",
        attrs={"database": "duckdb"},
    )
    notebook = obs.Notebook(
        cell,
        title="Demo",
        show_pinned_source=True,
    )

    source = notebook.to_notebook_html()
    scripts = script_tags(source)
    attrs = scripts[0]["attrs"]
    assert document_title(source) == "Demo"
    assert notebook.options["show_source"] is True
    assert len(scripts) == 1
    assert scripts[0]["text"].strip() == "answer = 42"
    assert attrs.get("id") == "7"
    assert attrs.get("type") == "application/vnd.observable.javascript"
    assert attrs.get("name") == "answer"
    assert attrs.get("output") == "answer"
    assert attrs.get("database") == "duckdb"
    assert "hidden" in attrs
    assert "pinned" in attrs


@pytest.mark.parametrize("theme", obs.NOTEBOOK_THEMES)
def test_notebook_accepts_shipped_notebook_kit_themes(
    theme: str,
    document_title: DocumentTitle,
) -> None:
    notebook = obs.Notebook(obs.ojs("answer = 42"), title="Demo", theme=theme)

    source = notebook.to_notebook_html()

    assert document_title(source) == "Demo"
    assert notebook.theme == theme
    assert notebook.spec["theme"] == theme
    assert f'<notebook theme="{theme}">' in source


def test_notebook_theme_mapping_normalizes_and_serializes() -> None:
    notebook = obs.Notebook(
        obs.ojs("answer = 42"),
        theme={"light": " Cotton ", "dark": "Near-Midnight"},
    )

    assert notebook.theme == {"light": "cotton", "dark": "near-midnight"}
    assert notebook.spec["theme"] == {"light": "cotton", "dark": "near-midnight"}
    assert '<notebook theme="light-dark(cotton, near-midnight)">' in (
        notebook.to_notebook_html()
    )


@pytest.mark.parametrize(
    "theme",
    [
        "unknown",
        {"light": "air"},
        {"light": "air", "dark": "slate", "extra": "coffee"},
        {"light": "air", "dark": "unknown"},
    ],
)
def test_notebook_rejects_unsupported_themes(theme: Any) -> None:
    with pytest.raises((TypeError, ValueError), match="theme|Unsupported"):
        obs.Notebook(obs.ojs("answer = 42"), theme=theme)


def test_notebook_theme_setter_syncs_spec_trait() -> None:
    notebook = obs.Notebook(obs.ojs("answer = 42"), theme="air")

    notebook.theme = "slate"

    assert notebook.theme == "slate"
    assert notebook.spec["theme"] == "slate"
    assert notebook.get_state(["theme", "spec"])["theme"] == "slate"
    assert notebook.get_state(["theme", "spec"])["spec"]["theme"] == "slate"


def test_source_backed_notebook_theme_trait_preserves_source() -> None:
    source = """<!doctype html>
<notebook theme="coffee">
  <script id="1">answer = 42</script>
</notebook>
"""
    notebook = obs.Notebook.from_html(source)

    notebook.theme = {"light": "cotton", "dark": "slate"}

    assert notebook.theme == {"light": "cotton", "dark": "slate"}
    assert notebook.spec == {}
    assert notebook.to_notebook_html() == source


def test_notebook_from_html_rejects_unsupported_theme() -> None:
    with pytest.raises(ValueError, match="Unsupported Notebook Kit theme"):
        obs.Notebook.from_html("<notebook theme='unknown'></notebook>")


def test_cell_raw_controls_serialized_source_dedenting(
    script_tags: ScriptTags,
) -> None:
    raw_script = script_tags(
        obs.Notebook(obs.ojs("  answer = 42", raw=True)).to_notebook_html()
    )[0]["text"]
    dedented_script = script_tags(
        obs.Notebook(obs.ojs("  answer = 42")).to_notebook_html()
    )[0]["text"]

    assert (
        _line_indent(raw_script, "answer = 42")
        - _line_indent(dedented_script, "answer = 42")
        == 2
    )


def test_notebook_constructor_accepts_initial_variables() -> None:
    notebook = obs.Notebook(
        obs.ojs("py_answer + 1"),
        variables={"py_answer": 7},
    )

    assert notebook.variables == {"py_answer": 7}


def test_public_api_rejects_unknown_constructor_options() -> None:
    bad_ojs: Any = obs.ojs
    bad_notebook: Any = obs.Notebook
    bad_from_html: Any = obs.Notebook.from_html
    bad_from_observablehq: Any = obs.Notebook.from_observablehq

    with pytest.raises(TypeError, match="positional"):
        bad_ojs("answer = 42", "answer")
    with pytest.raises(TypeError, match="unknown_option"):
        bad_notebook(obs.ojs("answer = 42"), unknown_option=True)
    with pytest.raises(TypeError, match="unknown_option"):
        bad_from_html("<notebook></notebook>", unknown_option=True)
    with pytest.raises(TypeError, match="unknown_option"):
        bad_from_observablehq("@d3/bar-chart", unknown_option=True)


def test_sql_mode_is_not_publicly_authorable() -> None:
    mode: Any = "sql"
    with pytest.raises(ValueError, match="Unsupported Python-authored cell mode"):
        obs.Notebook("select 1", mode=mode)


@pytest.mark.parametrize(
    ("specifier", "api_url"),
    [
        (
            "https://observablehq.com/@d3/bar-chart",
            "https://api.observablehq.com/document/@d3/bar-chart",
        ),
        (
            "https://observablehq.com/@d3/bar-chart/2",
            "https://api.observablehq.com/document/@d3/bar-chart/2",
        ),
        (
            "https://observablehq.com/@d3/bar-chart@latest",
            "https://api.observablehq.com/document/@d3/bar-chart@latest",
        ),
        (
            "https://observablehq.com/d/1234567890abcdef",
            "https://api.observablehq.com/document/1234567890abcdef",
        ),
        ("@d3/bar-chart", "https://api.observablehq.com/document/@d3/bar-chart"),
        (
            "1234567890abcdef",
            "https://api.observablehq.com/document/1234567890abcdef",
        ),
    ],
)
def test_observablehq_specifier_resolution_matches_document_api(
    observablehq_response: ObservableHQResponseInstaller,
    specifier: str,
    api_url: str,
) -> None:
    requests = observablehq_response({"title": "Remote", "nodes": []})

    obs.Notebook.from_observablehq(specifier, timeout=1)

    assert requests == [(api_url, 1)]


def test_observablehq_rejects_non_observable_specifier() -> None:
    with pytest.raises(ValueError, match="Invalid ObservableHQ notebook specifier"):
        obs.Notebook.from_observablehq("https://example.com/@d3/bar-chart")


def test_notebook_from_observablehq_fetches_source_and_remote_attachments(
    observablehq_response: ObservableHQResponseInstaller,
    script_tags: ScriptTags,
    document_title: DocumentTitle,
) -> None:
    observablehq_response(
        {
            "title": "Remote",
            "nodes": [{"id": 1, "mode": "js", "value": "answer = 42"}],
            "files": [
                {
                    "name": "data.csv",
                    "download_url": "https://static.example/data.csv",
                }
            ],
        }
    )

    widget = obs.Notebook.from_observablehq(
        "https://observablehq.com/@d3/bar-chart",
        timeout=1,
        attachments={"local.csv": "https://example.test/local.csv"},
    )

    source = widget.to_notebook_html()
    scripts = script_tags(source)
    assert document_title(source) == "Remote"
    assert scripts[0]["attrs"].get("type") == "application/vnd.observable.javascript"
    assert scripts[0]["text"].strip() == "answer = 42"
    assert set(widget.attachments) == {"data.csv", "local.csv"}
    assert widget.attachments["data.csv"]["url"] == "https://static.example/data.csv"
    assert widget.attachments["local.csv"]["url"] == "https://example.test/local.csv"
    assert len(widget.cells) == 1


def test_notebook_from_observablehq_accepts_initial_variables(
    observablehq_response: ObservableHQResponseInstaller,
    script_tags: ScriptTags,
) -> None:
    requests = observablehq_response(
        {
            "title": "Remote",
            "nodes": [{"id": 1, "mode": "js", "value": "py_answer + 1"}],
        }
    )

    widget = obs.Notebook.from_observablehq(
        "@d3/bar-chart",
        timeout=1,
        variables={"py_answer": 7},
    )

    scripts = script_tags(widget.to_notebook_html())
    assert requests == [("https://api.observablehq.com/document/@d3/bar-chart", 1)]
    assert scripts[0]["text"].strip() == "py_answer + 1"
    assert widget.variables == {"py_answer": 7}


def test_notebook_from_observablehq_initial_variables_serialize_to_frontend_state(
    observablehq_response: ObservableHQResponseInstaller,
    script_tags: ScriptTags,
) -> None:
    requests = observablehq_response(
        {
            "title": "Remote",
            "nodes": [{"id": 1, "mode": "js", "value": "py_answer + 1"}],
        }
    )

    widget = obs.Notebook.from_observablehq(
        "@d3/bar-chart",
        timeout=1,
        variables={"py_answer": 7},
    )

    scripts = script_tags(widget.to_notebook_html())
    assert requests == [("https://api.observablehq.com/document/@d3/bar-chart", 1)]
    assert scripts[0]["text"].strip() == "py_answer + 1"
    assert widget.get_state(["_variables"])["_variables"] == {"py_answer": 7}


def test_cell_defaults_to_observable_js_and_dedents(script_tags: ScriptTags) -> None:
    item = obs.ojs(
        """
        answer = 42
        """
    )

    scripts = script_tags(obs.Notebook(item).to_notebook_html())
    assert scripts[0]["attrs"].get("type") == "application/vnd.observable.javascript"
    assert scripts[0]["text"].strip() == "answer = 42"


def test_notebook_rejects_list_wrapped_cells() -> None:
    bad_cells: Any = [obs.ojs("answer = 42")]
    with pytest.raises(TypeError, match="strings or Cell objects"):
        obs.Notebook(bad_cells)


def test_notebook_cell_lookup_returns_child_widget_instances() -> None:
    widget = obs.Notebook(
        obs.md("# Title", name="title"),
        obs.ojs("answer = 42", name="answer"),
        title="Composed",
    )

    assert len(widget.cells) == 2
    assert [widget.cell(index).name for index in range(2)] == ["title", "answer"]
    assert [cell.name for cell in widget.cells] == ["title", "answer"]
    assert widget.cell("answer").name == "answer"
    assert widget.cell(1) is widget.cells[1]
    assert widget.cell("answer") is widget.cells[1]


def test_notebook_graph_exposes_symbolic_cell_metadata(
    browser_graph_sync: BrowserGraphSync,
    browser_graph_cell: BrowserGraphCellBuilder,
) -> None:
    widget = obs.Notebook(
        obs.ojs("a = 1", name="a"),
        obs.ojs("b = a + rows.length", name="b"),
        variables={"rows": [{"x": 1}]},
    )
    browser_graph_sync(
        widget,
        cells=[
            browser_graph_cell(
                "a",
                name="a",
                defines=["a"],
                output="a",
                runtime_outputs=["a"],
            ),
            browser_graph_cell(
                "b",
                name="b",
                defines=["b"],
                references=["a", "rows"],
                output="b",
                runtime_outputs=["b"],
            ),
        ],
        edges=[("a", "b", "a")],
    )

    graph = widget.graph

    assert graph is not None
    assert graph.defines == ("a", "b")
    assert graph.references == ("a", "rows")
    assert graph.external_references == ("rows",)
    assert graph.cell_for_variable("a").name == "a"
    assert graph.cell_for_variable("b").name == "b"
    assert [
        edge.variable
        for edge in graph.edges
        if edge.source_id == graph.cell_for_variable("a").id
        and edge.target_id == graph.cell_for_variable("b").id
    ] == ["a"]
    assert widget.cell("b").defines == ("b",)
    assert widget.cell("b").references == ("a", "rows")
    assert widget.cell("b").outputs == ()
    assert widget.cell("b").runtime_outputs == ("b",)
    assert widget.cell("b").output == "b"


def test_notebook_graph_drops_invalid_browser_entries() -> None:
    widget = obs.Notebook(obs.ojs("answer = 42", name="answer"))
    widget.set_trait(
        "_graph",
        {
            "cells": [
                {
                    "id": 1,
                    "index": 0,
                    "mode": "ojs",
                    "name": "answer",
                    "defines": ["answer"],
                },
                {"id": "bad", "index": 1, "mode": ""},
            ],
            "edges": [
                {"from": 1, "to": 2, "variable": "missing-target"},
                {"from": "bad", "to": 1, "variable": "bad-source"},
                {"from": 1, "to": 1, "variable": ""},
            ],
        },
    )

    graph = widget.graph

    assert graph is not None
    assert [cell.defines for cell in graph.cells] == [("answer",)]
    assert graph.edges == ()


def test_cell_lookup_can_use_unique_graph_output(
    browser_graph_sync: BrowserGraphSync,
    browser_graph_cell: BrowserGraphCellBuilder,
) -> None:
    widget = obs.Notebook(
        obs.ojs("answer = 42"),
        obs.ojs("answer + 1", name="readout"),
    )
    browser_graph_sync(
        widget,
        cells=[
            browser_graph_cell(
                "answer-cell",
                defines=["answer"],
                output="answer",
                runtime_outputs=["answer"],
            )
        ],
    )

    with pytest.raises(KeyError, match="Unknown Observable cell name"):
        widget.cell("answer")
    assert widget.cell_for_variable("answer") is widget.cells[0]
    assert widget.cell_for_variable("answer").defines == ("answer",)


def test_cell_lookup_rejects_ambiguous_graph_variable(
    browser_graph_sync: BrowserGraphSync,
    browser_graph_cell: BrowserGraphCellBuilder,
) -> None:
    widget = obs.Notebook(
        obs.ojs("answer = 42"),
        obs.ojs("answer = 43"),
    )
    browser_graph_sync(
        widget,
        cells=[
            browser_graph_cell("first-answer", defines=["answer"]),
            browser_graph_cell("second-answer", defines=["answer"]),
        ],
    )

    with pytest.raises(KeyError, match="Ambiguous Observable variable"):
        widget.cell_for_variable("answer")


def test_cell_lookup_separates_python_name_from_ojs_variable(
    browser_graph_sync: BrowserGraphSync,
    browser_graph_cell: BrowserGraphCellBuilder,
) -> None:
    widget = obs.Notebook(
        obs.ojs("alpha = 1", name="conflict"),
        obs.ojs("conflict = 2", name="other"),
    )
    browser_graph_sync(
        widget,
        cells=[
            browser_graph_cell("python-name", defines=["alpha"]),
            browser_graph_cell("ojs-variable", defines=["conflict"]),
        ],
    )

    assert widget.cell("conflict").defines == ("alpha",)
    assert widget.cell_for_variable("conflict").name == "other"
    assert widget.cell_for_variable("conflict").defines == ("conflict",)


def test_named_notebook_cells_expose_values(
    browser_value_sync: BrowserValueSync,
) -> None:
    widget = obs.Notebook(obs.ojs("viewof gain = Inputs.range([0, 11])", name="gain"))
    cell_widget = widget.cell("gain")

    browser_value_sync(cell_widget, {"gain": 7}, ["gain", "doubled"])

    assert cell_widget.value == 7
    assert cell_widget.values == {"gain": 7}
    assert widget.value("gain") == 7
    assert widget.values == {"gain": 7}


def test_cell_value_error_points_to_values_mapping(
    browser_value_sync: BrowserValueSync,
) -> None:
    cell_widget = obs.Notebook(obs.ojs("answer = 42", name="cell")).cell("cell")
    browser_value_sync(cell_widget, {"answer": 42, "double": 84})

    with pytest.raises(KeyError, match=r"cell\.values\[name\]"):
        _ = cell_widget.value


def test_browser_values_are_exposed_to_notebook_values(
    browser_value_sync: BrowserValueSync,
) -> None:
    widget = obs.Notebook(obs.ojs("viewof gain = Inputs.range([0, 11])", name="gain"))

    browser_value_sync(widget, {"gain": 8}, ["gain"])

    assert widget.values == {"gain": 8}
    assert widget.value("gain") == 8
    assert widget.value_names == ("gain",)


def test_script_end_tag_literal_stays_inside_script_cell(
    script_tags: ScriptTags,
) -> None:
    source = "html`</script></SCRIPT>`"
    widget = obs.Notebook(obs.ojs(source))

    scripts = script_tags(widget.to_notebook_html())

    assert len(scripts) == 1
    assert scripts[0]["attrs"].get("type") == "application/vnd.observable.javascript"
    text = scripts[0]["text"].strip()
    assert text == "html`<\\/script><\\/script>`"


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


def test_from_html_embeds_file_attachments_and_local_imports(
    tmp_path: pathlib.Path,
    script_tags: ScriptTags,
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

    assert set(widget.attachments) == {"data/points.csv"}
    mime_type, payload = decode_data_url(widget.attachments["data/points.csv"]["url"])
    assert mime_type == "text/csv"
    assert payload == b"x,y\n1,2\n"
    module_text = _script_by_id(script_tags(widget.to_notebook_html()), "1")["text"]
    _assert_javascript_import_payloads(
        module_text,
        [("import", b"export const value = 1;\n", ("value",), ())],
    )
    assert _normalized_source_with_embedded_imports(module_text) == _normalized_source(
        """
        import {value} from "<embedded>";
        const points = FileAttachment("data/points.csv").csv();
        display(value);
        """
    )
    assert len(widget.cells) == 1


def test_from_html_recursively_embeds_local_imports(
    tmp_path: pathlib.Path,
    script_tags: ScriptTags,
) -> None:
    (tmp_path / "nested.js").write_text("export const nested = 41;\n", encoding="utf-8")
    (tmp_path / "helper.js").write_text(
        'import {nested} from "./nested.js";\nexport const value = nested + 1;\n',
        encoding="utf-8",
    )
    notebook = tmp_path / "example.html"
    notebook.write_text(
        """<!doctype html>
<notebook>
  <script id="1" type="module">
    import {value} from "./helper.js";
    display(value);
  </script>
</notebook>
""",
        encoding="utf-8",
    )

    widget = _notebook_from_html_file(notebook)

    module_text = _script_by_id(script_tags(widget.to_notebook_html()), "1")["text"]
    [(kind, mime_type, payload, imported, exported)] = _decoded_data_imports(
        javascript_imports(module_text)
    )
    helper_text = payload.decode("utf-8")
    _assert_no_relative_javascript_import_specifiers(module_text)
    assert (kind, mime_type, imported, exported) == (
        "import",
        "text/javascript",
        ("value",),
        (),
    )
    assert _normalized_source_with_embedded_imports(helper_text) == _normalized_source(
        """
        import {nested} from "<embedded>";
        export const value = nested + 1;
        """
    )
    _assert_javascript_import_payloads(
        helper_text,
        [("import", b"export const nested = 41;\n", ("nested",), ())],
    )


def test_from_html_requires_html_string(tmp_path: pathlib.Path) -> None:
    path = tmp_path / "chart.html"
    path.write_text("<notebook></notebook>", encoding="utf-8")
    bad_source: Any = path

    with pytest.raises(TypeError, match="HTML string"):
        obs.Notebook.from_html(bad_source)


SOURCE_BACKED_NAMED_CELLS = """<!doctype html>
<notebook>
  <script id="10" type="text/markdown" name="title"># Title</script>
  <script id="11" type="module" name="svg">const svg = ({node: () => "live"});</script>
  <script id="12" type="module" name="display">svg.node()</script>
</notebook>
"""


def test_source_backed_notebook_exposes_one_cell_per_script() -> None:
    widget = obs.Notebook.from_html(SOURCE_BACKED_NAMED_CELLS)

    assert len(widget.cells) == 3
    assert [widget.cell(index).name for index in range(3)] == [
        "title",
        "svg",
        "display",
    ]
    display_cell = widget.cell("display")
    svg_cell = widget.cell("svg")
    assert display_cell.name == "display"
    assert svg_cell.name == "svg"


def test_source_backed_notebook_preserves_input_html() -> None:
    widget = obs.Notebook.from_html(SOURCE_BACKED_NAMED_CELLS)

    assert widget.to_notebook_html() == SOURCE_BACKED_NAMED_CELLS


def test_from_html_does_not_rewrite_markdown_import_text(
    tmp_path: pathlib.Path,
    script_tags: ScriptTags,
) -> None:
    (tmp_path / "helper.js").write_text("export const value = 1;\n", encoding="utf-8")
    notebook = tmp_path / "example.html"
    notebook.write_text(
        """<!doctype html>
	<notebook>
	  <script id="1" type="text/markdown">
	    Prose mentioning from "./helper.js" must remain text.
	  </script>
	</notebook>
	""",
        encoding="utf-8",
    )

    widget = _notebook_from_html_file(notebook)

    markdown_text = _script_by_id(script_tags(widget.to_notebook_html()), "1")["text"]
    assert (
        markdown_text.strip() == 'Prose mentioning from "./helper.js" must remain text.'
    )
    assert widget.attachments == {}


def test_from_html_rewrites_static_and_dynamic_javascript_imports(
    tmp_path: pathlib.Path,
    script_tags: ScriptTags,
) -> None:
    (tmp_path / "side-effect.js").write_text(
        "export const side = 1;\n", encoding="utf-8"
    )
    (tmp_path / "comment-side-effect.js").write_text(
        "export const commentedSide = 2;\n", encoding="utf-8"
    )
    (tmp_path / "named.js").write_text("export const value = 3;\n", encoding="utf-8")
    (tmp_path / "dynamic.js").write_text(
        "export const dynamic = 4;\n", encoding="utf-8"
    )
    (tmp_path / "dynamic-comment.js").write_text(
        "export const dynamicComment = 5;\n", encoding="utf-8"
    )
    notebook = tmp_path / "example.html"
    notebook.write_text(
        """<!doctype html>
<notebook>
	  <script id="2" type="module">
	    import "./side-effect.js";
	    import /* side effect */ "./comment-side-effect.js";
	    import {value} from /* from */ "./named.js";
	    const dynamic = html`${import("./dynamic.js")}`;
	    const dynamicWithComment = html`${import /* dynamic */ ("./dynamic-comment.js")}`;
	  </script>
	</notebook>
		""",
        encoding="utf-8",
    )

    widget = _notebook_from_html_file(notebook)

    module_text = _script_by_id(script_tags(widget.to_notebook_html()), "2")["text"]
    _assert_javascript_import_payloads(
        module_text,
        [
            ("import", b"export const side = 1;\n", (), ()),
            ("import", b"export const commentedSide = 2;\n", (), ()),
            ("import", b"export const value = 3;\n", ("value",), ()),
            ("dynamic-import", b"export const dynamic = 4;\n", (), ()),
            (
                "dynamic-import",
                b"export const dynamicComment = 5;\n",
                (),
                (),
            ),
        ],
    )
    assert _normalized_source_with_embedded_imports(module_text) == _normalized_source(
        """
        import "<embedded>";
        import /* side effect */ "<embedded>";
        import {value} from /* from */ "<embedded>";
        const dynamic = html`${import("<embedded>")}`;
        const dynamicWithComment = html`${import /* dynamic */ ("<embedded>")}`;
        """
    )
    assert len(widget.cells) == 1


def test_from_html_preserves_non_executable_import_text(
    tmp_path: pathlib.Path,
    script_tags: ScriptTags,
) -> None:
    (tmp_path / "helper.js").write_text("export const value = 1;\n", encoding="utf-8")
    notebook = tmp_path / "example.html"
    notebook.write_text(
        """<!doctype html>
<notebook>
	  <script id="1" type="module">
	    import "./helper.js";
	    // import "./helper.js";
	    const literal = 'import "./helper.js"';
	    const importPattern = /import\\("\\.\\/helper\\.js"\\)/;
	  </script>
	</notebook>
""",
        encoding="utf-8",
    )

    widget = _notebook_from_html_file(notebook)

    module_text = _script_by_id(script_tags(widget.to_notebook_html()), "1")["text"]
    _assert_javascript_import_payloads(
        module_text,
        [("import", b"export const value = 1;\n", (), ())],
    )
    assert _normalized_source_with_embedded_imports(module_text) == _normalized_source(
        r"""
        import "<embedded>";
        // import "./helper.js";
        const literal = 'import "./helper.js"';
        const importPattern = /import\("\.\/helper\.js"\)/;
        """
    )


def test_from_html_does_not_rewrite_import_named_methods(
    tmp_path: pathlib.Path,
    script_tags: ScriptTags,
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

    module_text = _script_by_id(script_tags(widget.to_notebook_html()), "1")["text"]
    _assert_javascript_import_payloads(
        module_text,
        [("dynamic-import", b"export const value = 1;\n", (), ())],
    )
    assert _normalized_source_with_embedded_imports(module_text) == _normalized_source(
        """
        const method = obj.import("./helper.js");
        const optional = obj?.import("./helper.js");
        const privateMethod = this.#import("./helper.js");
        const real = import("<embedded>");
        """
    )


def test_from_html_allows_comments_between_file_attachment_tokens(
    tmp_path: pathlib.Path,
    script_tags: ScriptTags,
) -> None:
    (tmp_path / "block.csv").write_text("x,y\n1,2\n", encoding="utf-8")
    (tmp_path / "line.csv").write_text("x,y\n3,4\n", encoding="utf-8")
    notebook = tmp_path / "example.html"
    notebook.write_text(
        """<!doctype html>
<notebook>
  <script id="1" type="module">
    const a = FileAttachment /* block */ ("block.csv").csv();
    const b = FileAttachment // line
      ("line.csv").csv();
  </script>
</notebook>
""",
        encoding="utf-8",
    )

    widget = _notebook_from_html_file(notebook)
    module_text = _script_by_id(script_tags(widget.to_notebook_html()), "1")["text"]

    assert set(widget.attachments) == {"block.csv", "line.csv"}
    assert _normalized_source(module_text) == _normalized_source(
        """
        const a = FileAttachment /* block */ ("block.csv").csv();
        const b = FileAttachment // line
          ("line.csv").csv();
        """
    )
    assert decode_data_url(widget.attachments["block.csv"]["url"])[1] == b"x,y\n1,2\n"
    assert decode_data_url(widget.attachments["line.csv"]["url"])[1] == b"x,y\n3,4\n"


def test_from_html_embeds_static_template_and_stdlib_alias_file_attachments(
    tmp_path: pathlib.Path,
    script_tags: ScriptTags,
) -> None:
    (tmp_path / "templated.csv").write_text("x\n1\n", encoding="utf-8")
    (tmp_path / "aliased.csv").write_text("x\n2\n", encoding="utf-8")
    (tmp_path / "dynamic.csv").write_text("x\n3\n", encoding="utf-8")
    notebook = tmp_path / "example.html"
    notebook.write_text(
        """<!doctype html>
<notebook>
  <script id="1" type="module">
    import {FileAttachment as localFile} from "observablehq:stdlib";
    const name = "dynamic";
    const a = FileAttachment(`templated.csv`).csv();
    const b = localFile("aliased.csv").csv();
    const c = FileAttachment(`${name}.csv`).csv();
  </script>
</notebook>
""",
        encoding="utf-8",
    )

    widget = _notebook_from_html_file(notebook)
    module_text = _script_by_id(script_tags(widget.to_notebook_html()), "1")["text"]

    assert set(widget.attachments) == {"templated.csv", "aliased.csv"}
    assert _normalized_source(module_text) == _normalized_source(
        """
        import {FileAttachment as localFile} from "observablehq:stdlib";
        const name = "dynamic";
        const a = FileAttachment(`templated.csv`).csv();
        const b = localFile("aliased.csv").csv();
        const c = FileAttachment(`${name}.csv`).csv();
        """
    )
    assert decode_data_url(widget.attachments["templated.csv"]["url"])[1] == b"x\n1\n"
    assert decode_data_url(widget.attachments["aliased.csv"]["url"])[1] == b"x\n2\n"


def test_from_html_embeds_only_bare_file_attachment_calls(
    tmp_path: pathlib.Path,
    script_tags: ScriptTags,
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
    module_text = _script_by_id(script_tags(widget.to_notebook_html()), "1")["text"]

    assert set(widget.attachments) == {"data.csv"}
    assert _normalized_source(module_text) == _normalized_source(
        """
        obj.FileAttachment("secret.csv");
        obj?.FileAttachment("secret.csv");
        this.#FileAttachment("secret.csv");
        $FileAttachment("secret.csv");
        FileAttachment("data.csv");
        """
    )
    assert decode_data_url(widget.attachments["data.csv"]["url"])[1] == b"x,y\n1,2\n"


@pytest.mark.parametrize(
    ("script_type", "body"),
    [
        (
            "text/markdown",
            'Prose mentioning FileAttachment("secret.csv") must not embed it.',
        ),
        ("module", '// FileAttachment("secret.csv")'),
        ("module", "const literal = 'FileAttachment(\"secret.csv\")';"),
        ("module", r'const attachmentPattern = /FileAttachment\("secret.csv"\)/;'),
        ("module", r'function pattern() { return /FileAttachment\("secret.csv"\)/; }'),
        (
            "module",
            r'function sameLine() { const s = "//"; return /FileAttachment\("secret.csv"\)/; }',
        ),
        ("module", r'function fail() { throw /FileAttachment\("secret.csv"\)/; }'),
        (
            "module",
            r'function blockComment() { return /* c */ /FileAttachment\("secret.csv"\)/; }',
        ),
        (
            "module",
            'function lineComment() { throw // c\n  /FileAttachment\\("secret.csv"\\)/; }',
        ),
        ("module", 'if (false) /FileAttachment("secret.csv")/.test("x");'),
        ("module", 'while (false) /FileAttachment("secret.csv")/.test("x");'),
        ("module", 'for (; false;) /FileAttachment("secret.csv")/.test("x");'),
        ("module", 'with ({}) /FileAttachment("secret.csv")/.test("x");'),
        (
            "module",
            'async function f(xs) {\n  for await (const x of xs) /FileAttachment("secret.csv")/.test(x);\n}',
        ),
        (
            "module",
            r'if (false) {} else /FileAttachment\("secret.csv"\)/.test("x");',
        ),
        ("module", r'do /FileAttachment\("secret.csv"\)/.test("x"); while (false);'),
        ("module", r'for (const x of /FileAttachment\("secret.csv"\)/) {}'),
        ("module", r'if ("x" in /FileAttachment\("secret.csv"\)/) {}'),
        ("module", r'if ("x" instanceof /FileAttachment\("secret.csv"\)/) {}'),
    ],
)
def test_from_html_embeds_only_executable_file_attachments(
    tmp_path: pathlib.Path,
    script_tags: ScriptTags,
    script_type: str,
    body: str,
) -> None:
    (tmp_path / "image.csv").write_text("name\nplot\n", encoding="utf-8")
    (tmp_path / "points.csv").write_text("x,y\n1,2\n", encoding="utf-8")
    (tmp_path / "secret.csv").write_text("x,y\n9,9\n", encoding="utf-8")
    notebook = tmp_path / "example.html"
    notebook.write_text(
        f"""<!doctype html>
<notebook>
  <script id="1" type="{script_type}">
{body}
  </script>
  <script id="2" type="module">
    const image = html`<img src=${{FileAttachment("image.csv").url()}}>`;
    const points = FileAttachment("points.csv").csv();
  </script>
</notebook>
""",
        encoding="utf-8",
    )

    widget = _notebook_from_html_file(notebook)
    ignored_text = _script_by_id(script_tags(widget.to_notebook_html()), "1")["text"]
    module_text = _script_by_id(script_tags(widget.to_notebook_html()), "2")["text"]

    assert set(widget.attachments) == {"image.csv", "points.csv"}
    assert _normalized_source(ignored_text) == _normalized_source(body)
    assert _normalized_source(module_text) == _normalized_source(
        """
        const image = html`<img src=${FileAttachment("image.csv").url()}>`;
        const points = FileAttachment("points.csv").csv();
        """
    )
    assert decode_data_url(widget.attachments["image.csv"]["url"])[1] == b"name\nplot\n"
    mime_type, payload = decode_data_url(widget.attachments["points.csv"]["url"])
    assert mime_type == "text/csv"
    assert payload == b"x,y\n1,2\n"


@pytest.mark.parametrize(
    "body",
    [
        'promise.catch(handler) / FileAttachment("data.csv").size;',
        'obj.return / FileAttachment("data.csv").size;',
        'obj.await / FileAttachment("data.csv").size;',
        'this.#return / FileAttachment("data.csv").size;',
        'this.#catch(handler) / FileAttachment("data.csv").size;',
    ],
)
def test_from_html_discovers_file_attachments_after_member_expression_division(
    tmp_path: pathlib.Path,
    script_tags: ScriptTags,
    body: str,
) -> None:
    (tmp_path / "data.csv").write_text("x,y\n1,2\n", encoding="utf-8")
    notebook = tmp_path / "example.html"
    notebook.write_text(
        f"""<!doctype html>
<notebook>
  <script id="1" type="module">
    {body}
  </script>
</notebook>
""",
        encoding="utf-8",
    )

    widget = _notebook_from_html_file(notebook)
    module_text = _script_by_id(script_tags(widget.to_notebook_html()), "1")["text"]

    assert set(widget.attachments) == {"data.csv"}
    assert module_text.strip() == body
    assert decode_data_url(widget.attachments["data.csv"]["url"])[1] == b"x,y\n1,2\n"


def test_from_html_respects_unquoted_script_types(
    tmp_path: pathlib.Path,
    script_tags: ScriptTags,
) -> None:
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

    scripts = script_tags(widget.to_notebook_html())
    markdown_script = _script_by_id(scripts, "1")
    module_script = _script_by_id(scripts, "2")
    markdown_text = markdown_script["text"]
    module_text = module_script["text"]
    assert markdown_script["attrs"].get("type") == "text/markdown"
    assert module_script["attrs"].get("type") == "module"
    assert _normalized_source(markdown_text) == _normalized_source(
        """
        import "./helper.js"
        FileAttachment("secret.csv")
        """
    )
    _assert_javascript_import_payloads(
        module_text,
        [("import", b"export const value = 1;\n", (), ())],
    )
    assert _normalized_source_with_embedded_imports(module_text) == _normalized_source(
        """
        import "<embedded>";
        FileAttachment("points.csv");
        """
    )
    assert set(widget.attachments) == {"points.csv"}


def test_from_html_ignores_data_type_when_script_type_is_absent(
    tmp_path: pathlib.Path,
    script_tags: ScriptTags,
) -> None:
    (tmp_path / "first.js").write_text("export const first = 1;\n", encoding="utf-8")
    (tmp_path / "second.js").write_text("export const second = 2;\n", encoding="utf-8")
    (tmp_path / "points.csv").write_text("x,y\n1,2\n", encoding="utf-8")
    notebook = tmp_path / "example.html"
    notebook.write_text(
        """<!doctype html>
<notebook>
  <script id="1" data-type="text/markdown">
    import "./first.js";
    FileAttachment("points.csv");
  </script>
  <script id="2" data-note=" type=text/markdown ">
    import "./second.js";
    FileAttachment("points.csv");
  </script>
</notebook>
""",
        encoding="utf-8",
    )

    widget = _notebook_from_html_file(notebook)

    scripts = script_tags(widget.to_notebook_html())
    first_text = _script_by_id(scripts, "1")["text"]
    second_text = _script_by_id(scripts, "2")["text"]
    _assert_javascript_import_payloads(
        first_text,
        [("import", b"export const first = 1;\n", (), ())],
    )
    _assert_javascript_import_payloads(
        second_text,
        [("import", b"export const second = 2;\n", (), ())],
    )
    assert _normalized_source_with_embedded_imports(first_text) == _normalized_source(
        """
        import "<embedded>";
        FileAttachment("points.csv");
        """
    )
    assert _normalized_source_with_embedded_imports(second_text) == _normalized_source(
        """
        import "<embedded>";
        FileAttachment("points.csv");
        """
    )
    assert set(widget.attachments) == {"points.csv"}


def test_from_html_handles_gt_in_script_attribute_values(
    tmp_path: pathlib.Path,
    script_tags: ScriptTags,
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

    script = _script_by_id(script_tags(widget.to_notebook_html()), "1")
    module_text = script["text"]
    assert script["attrs"].get("data-note") == ">"
    _assert_javascript_import_payloads(
        module_text,
        [("import", b"export const value = 1;\n", (), ())],
    )
    assert _normalized_source_with_embedded_imports(module_text) == _normalized_source(
        """
        import "<embedded>";
        FileAttachment("points.csv");
        """
    )
    assert set(widget.attachments) == {"points.csv"}


def test_from_html_ignores_scripts_outside_notebook(
    tmp_path: pathlib.Path,
    script_tags: ScriptTags,
    all_script_tags: ScriptTags,
) -> None:
    (tmp_path / "outside-helper.js").write_text(
        "export const outside = 1;\n", encoding="utf-8"
    )
    (tmp_path / "inside-helper.js").write_text(
        "export const inside = 1;\n", encoding="utf-8"
    )
    (tmp_path / "secret.csv").write_text("x,y\n9,9\n", encoding="utf-8")
    notebook = tmp_path / "example.html"
    notebook.write_text(
        """<!doctype html>
<script type="module">
  import "./outside-helper.js";
  FileAttachment("secret.csv");
</script>
<notebook>
  <script id="1" type="text/markdown">
    import "./inside-helper.js";
  </script>
</notebook>
""",
        encoding="utf-8",
    )

    widget = _notebook_from_html_file(notebook)
    rendered = widget.to_notebook_html()
    scripts = script_tags(rendered)
    outside_scripts = [
        script
        for script in all_script_tags(rendered)
        if script["attrs"].get("id") is None
    ]
    notebook_script = _script_by_id(scripts, "1")

    assert widget.attachments == {}
    assert len(widget.cells) == 1
    assert len(outside_scripts) == 1
    assert _normalized_source(outside_scripts[0]["text"]) == _normalized_source(
        """
        import "./outside-helper.js";
        FileAttachment("secret.csv");
        """
    )
    assert [script["attrs"].get("id") for script in scripts] == ["1"]
    assert notebook_script["attrs"].get("type") == "text/markdown"
    assert _normalized_source(notebook_script["text"]) == _normalized_source(
        """
        import "./inside-helper.js";
        """
    )


def test_from_html_ignores_script_tags_inside_html_comments(
    tmp_path: pathlib.Path,
    script_tags: ScriptTags,
    comment_nodes: CommentNodes,
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
    rendered = widget.to_notebook_html()
    scripts = script_tags(rendered)
    comments = comment_nodes(rendered)
    real_script = _script_by_id(scripts, "real")

    assert widget.attachments == {}
    assert len(widget.cells) == 1
    assert [script["attrs"].get("id") for script in scripts] == ["real"]
    assert real_script["text"].strip() == "const value = 1;"
    ignored_comment = next(
        comment for comment in comments if 'id="commented"' in comment
    )
    assert _normalized_source(ignored_comment) == _normalized_source(
        """
        <script id="commented" type="module">
          import "./helper.js";
          FileAttachment("secret.csv");
        </script>
        """
    )


def test_from_html_ignores_longer_closing_tag_prefixes(
    tmp_path: pathlib.Path,
    script_tags: ScriptTags,
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

    module_text = _script_by_id(script_tags(widget.to_notebook_html()), "1")["text"]
    _assert_javascript_import_payloads(
        module_text,
        [("import", b"export const value = 1;\n", (), ())],
    )
    assert _normalized_source_with_embedded_imports(module_text) == _normalized_source(
        """
        const tag = "</scripture>";
        import "<embedded>";
        FileAttachment("points.csv");
        """
    )
    assert set(widget.attachments) == {"points.csv"}


def test_from_html_ignores_notebook_close_text_inside_script(
    tmp_path: pathlib.Path,
    script_tags: ScriptTags,
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

    module_text = _script_by_id(script_tags(widget.to_notebook_html()), "1")["text"]
    _assert_javascript_import_payloads(
        module_text,
        [("import", b"export const value = 1;\n", (), ())],
    )
    assert _normalized_source_with_embedded_imports(module_text) == _normalized_source(
        """
        const tag = "</notebook>";
        import "<embedded>";
        FileAttachment("points.csv");
        """
    )
    assert set(widget.attachments) == {"points.csv"}


def test_from_html_treats_unknown_script_type_as_javascript(
    tmp_path: pathlib.Path,
    script_tags: ScriptTags,
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

    assert len(widget.cells) == 1
    module_text = _script_by_id(script_tags(widget.to_notebook_html()), "1")["text"]
    _assert_javascript_import_payloads(
        module_text,
        [("import", b"export const value = 1;\n", (), ())],
    )
    assert _normalized_source_with_embedded_imports(module_text) == _normalized_source(
        """
        import "<embedded>";
        FileAttachment("points.csv");
        """
    )
    assert set(widget.attachments) == {"points.csv"}


def test_from_html_rewrites_minified_static_imports(
    tmp_path: pathlib.Path,
    script_tags: ScriptTags,
) -> None:
    (tmp_path / "import-helper.js").write_text(
        "export const value = 1;\n", encoding="utf-8"
    )
    (tmp_path / "export-helper.js").write_text(
        "export const value = 2;\n", encoding="utf-8"
    )
    notebook = tmp_path / "example.html"
    notebook.write_text(
        """<!doctype html>
<notebook>
  <script id="1" type="module">
    import{value}from"./import-helper.js";
    export{value}from"./export-helper.js";
  </script>
</notebook>
""",
        encoding="utf-8",
    )

    widget = _notebook_from_html_file(notebook)

    module_text = _script_by_id(script_tags(widget.to_notebook_html()), "1")["text"]
    _assert_javascript_import_payloads(
        module_text,
        [
            ("import", b"export const value = 1;\n", ("value",), ()),
            ("export", b"export const value = 2;\n", (), ("value",)),
        ],
    )
