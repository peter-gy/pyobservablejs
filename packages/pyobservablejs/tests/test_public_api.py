from __future__ import annotations

import inspect
from importlib.metadata import version as package_version
from typing import Any

import observablejs as obs
import pytest
from helpers import DocumentTitle, ScriptTags, line_indent


def test_public_namespace_is_small() -> None:
    expected_public = {
        "NOTEBOOK_THEMES",
        "Cell",
        "CellInfo",
        "CellValues",
        "DependencyEdge",
        "Notebook",
        "NotebookCell",
        "NotebookView",
        "NotebookGraph",
        "NotRenderedError",
        "html",
        "js",
        "md",
        "ojs",
    }
    assert set(obs.__all__) == expected_public
    assert {name for name in dir(obs) if not name.startswith("_")} == expected_public

    namespace: dict[str, object] = {}
    exec("from observablejs import *", namespace)

    assert {name for name in namespace if not name.startswith("_")} == expected_public


def test_version_matches_package_metadata() -> None:
    assert obs.__version__ == package_version("pyobservablejs")


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


@pytest.mark.parametrize(
    ("apis", "parameter_names", "first_kind"),
    [
        pytest.param(
            (obs.Notebook,),
            (
                "cells",
                "title",
                "theme",
                "files",
                "base_path",
                "variables",
                "show_pinned_source",
            ),
            inspect.Parameter.VAR_POSITIONAL,
            id="Notebook",
        ),
        pytest.param(
            (obs.Notebook.from_html,),
            (
                "source",
                "files",
                "base_path",
                "embed_file_attachments",
                "rewrite_imports",
                "variables",
                "show_pinned_source",
            ),
            inspect.Parameter.POSITIONAL_OR_KEYWORD,
            id="from_html",
        ),
        pytest.param(
            (obs.Notebook.from_html_file,),
            (
                "path",
                "files",
                "embed_file_attachments",
                "rewrite_imports",
                "variables",
                "show_pinned_source",
            ),
            inspect.Parameter.POSITIONAL_OR_KEYWORD,
            id="from_html_file",
        ),
        pytest.param(
            (obs.Notebook.from_observablehq,),
            ("specifier", "variables", "files", "show_pinned_source", "timeout"),
            inspect.Parameter.POSITIONAL_OR_KEYWORD,
            id="from_observablehq",
        ),
        pytest.param(
            (obs.Notebook.from_observablehq_document,),
            ("document", "title", "variables", "files", "show_pinned_source"),
            inspect.Parameter.POSITIONAL_OR_KEYWORD,
            id="from_observablehq_document",
        ),
        pytest.param(
            (obs.Notebook.from_observablehq_page_data,),
            ("page_data", "title", "variables", "files", "show_pinned_source"),
            inspect.Parameter.POSITIONAL_OR_KEYWORD,
            id="from_observablehq_page_data",
        ),
        pytest.param(
            (obs.Notebook.from_observablehq_nodes,),
            (
                "nodes",
                "observable_files",
                "title",
                "variables",
                "files",
                "show_pinned_source",
            ),
            inspect.Parameter.POSITIONAL_OR_KEYWORD,
            id="from_observablehq_nodes",
        ),
        pytest.param(
            (obs.ojs, obs.js, obs.md, obs.html),
            (
                "source",
                "key",
                "display",
                "raw",
                "id",
                "pinned",
                "output",
                "notebookkit_attrs",
            ),
            inspect.Parameter.POSITIONAL_OR_KEYWORD,
            id="cell_helpers",
        ),
    ],
)
def test_public_api_signatures_keep_keyword_only_options(
    apis: tuple[Any, ...],
    parameter_names: tuple[str, ...],
    first_kind: Any,
) -> None:
    for api in apis:
        parameters = tuple(inspect.signature(api).parameters.values())
        assert tuple(parameter.name for parameter in parameters) == parameter_names
        assert parameters[0].kind is first_kind
        assert all(
            parameter.kind is inspect.Parameter.KEYWORD_ONLY
            for parameter in parameters[1:]
        )


def test_cell_options_serialize_to_notebook_html(
    script_tags: ScriptTags,
) -> None:
    cell = obs.ojs(
        "answer = 42",
        key="answer",
        display=False,
        id=7,
        pinned=True,
        output="answer",
        notebookkit_attrs={"database": "duckdb"},
    )
    notebook = obs.Notebook(
        cell,
    )

    source = notebook.to_notebook_html()
    scripts = script_tags(source)
    attrs = scripts[0]["attrs"]
    assert len(scripts) == 1
    assert scripts[0]["text"].strip() == "answer = 42"
    assert attrs.get("id") == "7"
    assert attrs.get("type") == "application/vnd.observable.javascript"
    assert "name" not in attrs
    assert attrs.get("output") == "answer"
    assert attrs.get("database") == "duckdb"
    assert "hidden" in attrs
    assert "pinned" in attrs


def test_show_pinned_source_sets_renderer_option() -> None:
    notebook = obs.Notebook(
        obs.ojs("answer = 42", pinned=True),
        show_pinned_source=True,
    )

    assert notebook.options == {"show_source": True}


def test_notebook_kit_sources_sync_notebook_kit_runtime_profile() -> None:
    notebooks = [
        obs.Notebook(),
        obs.Notebook.from_html("<!doctype html><notebook></notebook>"),
    ]

    assert [notebook.get_state(["_runtime_profile"]) for notebook in notebooks] == [
        {"_runtime_profile": "notebook-kit"},
        {"_runtime_profile": "notebook-kit"},
    ]


def test_observablehq_html_round_trip_preserves_classic_runtime_profile() -> None:
    notebook = obs.Notebook.from_observablehq_document(
        {
            "id": "0123456789abcdef",
            "version": 1,
            "nodes": [{"id": 1, "mode": "js", "value": "answer = 42"}],
        }
    )

    restored = obs.Notebook.from_html(notebook.to_notebook_html())

    with pytest.raises(ValueError, match="Reserved Observable runtime name: 'require'"):
        restored.update_variables(require="shadowed")


def test_cell_notebookkit_attrs_reject_first_class_option_collisions() -> None:
    with pytest.raises(ValueError, match="first-class cell options: hidden, output"):
        obs.ojs(
            "answer = 42",
            output="answer",
            notebookkit_attrs={"hidden": True, "output": "other"},
        )


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


def test_notebook_theme_setter_syncs_spec_transport() -> None:
    notebook = obs.Notebook(obs.ojs("answer = 42"), theme="air")

    notebook.theme = "slate"

    assert notebook.theme == "slate"
    assert notebook.spec["theme"] == "slate"
    assert notebook.get_state(["theme", "_spec"])["theme"] == "slate"
    assert notebook.get_state(["theme", "_spec"])["_spec"]["theme"] == "slate"


def test_closed_notebook_rejects_theme_mutation() -> None:
    notebook = obs.Notebook(obs.ojs("answer = 42"), theme="air")
    notebook.close()

    with pytest.raises(RuntimeError, match="closed Notebook"):
        notebook.theme = "slate"

    assert notebook.theme == "air"
    assert notebook.spec["theme"] == "air"


def test_source_backed_notebook_theme_trait_is_source_owned() -> None:
    source = """<!doctype html>
<notebook theme="coffee">
  <script id="1">answer = 42</script>
</notebook>
"""
    notebook = obs.Notebook.from_html(source)

    with pytest.raises(Exception, match="source HTML"):
        notebook.theme = {"light": "cotton", "dark": "slate"}

    assert notebook.theme == "coffee"
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
        line_indent(raw_script, "answer = 42")
        - line_indent(dedented_script, "answer = 42")
        == 2
    )


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


def test_notebook_requires_explicit_cell_helpers() -> None:
    source: Any = "answer = 42"
    with pytest.raises(TypeError, match="obs.ojs"):
        obs.Notebook(source)
