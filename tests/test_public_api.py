from __future__ import annotations

import inspect
from typing import Any

import pyobservablejs as obs
import pytest
from helpers import DocumentTitle, ScriptTags, line_indent


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
        line_indent(raw_script, "answer = 42")
        - line_indent(dedented_script, "answer = 42")
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
