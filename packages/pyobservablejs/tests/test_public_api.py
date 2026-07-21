from __future__ import annotations

import inspect
from collections.abc import Mapping
from importlib.metadata import version as package_version
from typing import Any, assert_type, cast

import observablejs as obs
import pytest
from helpers import DocumentTitle, ScriptTags, line_indent, notebook_session


def test_public_namespace_is_small() -> None:
    expected_public = {
        "NOTEBOOK_THEMES",
        "Cell",
        "CellInfo",
        "DependencyEdge",
        "Notebook",
        "NotebookCell",
        "NotebookView",
        "NotebookGraph",
        "html",
        "js",
        "md",
        "ojs",
        "types",
        "view_from_code",
        "view_from_html",
        "view_from_observablehq",
        "view_from_observablehq_document",
    }
    assert set(obs.__all__) == expected_public
    assert {name for name in dir(obs) if not name.startswith("_")} == expected_public

    namespace: dict[str, object] = {}
    exec("from observablejs import *", namespace)

    assert {name for name in namespace if not name.startswith("_")} == expected_public


def test_public_object_discovery_matches_ownership_model() -> None:
    notebook = obs.Notebook(obs.ojs("answer = 42", key="answer"))
    view = notebook.view()

    try:
        assert {
            "attachments",
            "cell",
            "cells",
            "close",
            "from_html",
            "from_observablehq",
            "from_observablehq_document",
            "replace_variables",
            "reset_variables",
            "state",
            "theme",
            "to_notebook_html",
            "update_variables",
            "variables",
            "view",
        } <= {name for name in dir(notebook) if not name.startswith("_")}
        assert {
            name for name in dir(notebook.cell("answer")) if not name.startswith("_")
        } == {
            "id",
            "index",
            "key",
        }
        assert all(
            not hasattr(view, name)
            for name in (
                "replace_variables",
                "reset_variables",
                "update_variables",
                "variables",
            )
        )
    finally:
        notebook.close()


def test_view_and_variable_mutation_signatures_have_one_argument_shape() -> None:
    view_parameters = tuple(inspect.signature(obs.Notebook.view).parameters.values())
    assert [parameter.name for parameter in view_parameters] == ["self", "selectors"]
    assert view_parameters[1].kind is inspect.Parameter.VAR_POSITIONAL

    cell_parameters = tuple(inspect.signature(obs.Notebook.cell).parameters.values())
    assert [parameter.name for parameter in cell_parameters] == ["self", "key"]
    assert cell_parameters[1].annotation in {"str", str}

    for method in (obs.Notebook.update_variables, obs.Notebook.replace_variables):
        parameters = tuple(inspect.signature(method).parameters.values())
        assert [parameter.name for parameter in parameters] == ["self", "values"]
        assert parameters[1].kind is inspect.Parameter.POSITIONAL_ONLY


def test_advanced_types_are_namespaced_and_complete() -> None:
    assert set(obs.types.__all__) == {
        "BrowserErrorValue",
        "CellError",
        "CellFormat",
        "CellMode",
        "CellResult",
        "CellSelector",
        "CellStatus",
        "ErrorPhase",
        "FileInput",
        "FileSnapshot",
        "FileSpec",
        "NotebookKitCellMetadata",
        "NotebookState",
        "NotebookTheme",
        "ObservableData",
        "ObservableDisplay",
        "ObservableDocument",
        "ObservableFile",
        "ObservableNode",
        "ObservableSource",
        "Theme",
        "ThemePair",
        "ThemeSnapshot",
        "ViewError",
        "ViewState",
    }


def test_state_traits_have_public_static_types() -> None:
    notebook = obs.Notebook(
        obs.ojs("answer = 42", key="answer"),
        files={"data.csv": "https://example.test/data.csv"},
    )
    view = notebook.view()

    assert_type(notebook.state, obs.types.NotebookState)
    assert_type(view.state, obs.types.ViewState)
    attachment = notebook.attachments["data.csv"]
    assert_type(attachment, obs.types.FileSnapshot)
    assert_type(attachment.get("url"), str | None)
    mapping: Mapping[str, str | int] = attachment
    assert mapping["url"] == "https://example.test/data.csv"


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
            (obs.view_from_code,),
            (
                "code",
                "mode",
                "title",
                "theme",
                "files",
                "base_path",
                "variables",
            ),
            inspect.Parameter.POSITIONAL_OR_KEYWORD,
            id="view_from_code",
        ),
        pytest.param(
            (obs.Notebook.from_html, obs.view_from_html),
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
            (obs.Notebook.from_observablehq, obs.view_from_observablehq),
            ("specifier", "variables", "files", "show_pinned_source", "timeout"),
            inspect.Parameter.POSITIONAL_OR_KEYWORD,
            id="from_observablehq",
        ),
        pytest.param(
            (
                obs.Notebook.from_observablehq_document,
                obs.view_from_observablehq_document,
            ),
            ("document", "title", "variables", "files", "show_pinned_source"),
            inspect.Parameter.POSITIONAL_OR_KEYWORD,
            id="from_observablehq_document",
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
    assert attrs.get("data-pyobservablejs-key") == "answer"
    assert attrs.get("name") is None
    assert attrs.get("output") == "answer"
    assert attrs.get("database") == "duckdb"
    assert "hidden" in attrs
    assert "pinned" in attrs


def test_implicit_cell_ids_skip_explicit_ids(script_tags: ScriptTags) -> None:
    notebook = obs.Notebook(
        obs.ojs("first = 1", id=2),
        obs.ojs("second = 2"),
        obs.ojs("third = 3", id=5),
        obs.ojs("fourth = 4"),
    )

    scripts = script_tags(notebook.to_notebook_html())

    assert [script["attrs"].get("id") for script in scripts] == ["2", "3", "5", "6"]


@pytest.mark.parametrize("cell_id", [0, -1, 9007199254740992])
def test_cell_rejects_ids_outside_the_javascript_safe_range(cell_id: int) -> None:
    with pytest.raises(ValueError, match="between 1 and 9007199254740991"):
        obs.ojs("answer = 42", id=cell_id)


def test_cell_accepts_the_largest_javascript_safe_id(
    script_tags: ScriptTags,
) -> None:
    notebook = obs.Notebook(obs.ojs("answer = 42", id=9007199254740991))

    [script] = script_tags(notebook.to_notebook_html())

    assert script["attrs"].get("id") == "9007199254740991"


def test_implicit_cell_ids_wrap_after_the_largest_safe_id(
    script_tags: ScriptTags,
) -> None:
    notebook = obs.Notebook(
        obs.ojs("maximum = 1", id=9007199254740991),
        obs.ojs("first = 2"),
        obs.ojs("second = 3"),
    )

    scripts = script_tags(notebook.to_notebook_html())

    assert [script["attrs"].get("id") for script in scripts] == [
        "9007199254740991",
        "1",
        "2",
    ]


def test_notebook_rejects_duplicate_explicit_cell_ids() -> None:
    with pytest.raises(ValueError, match="Notebook cell ids must be unique: 7"):
        obs.Notebook(
            obs.ojs("first = 1", id=7),
            obs.ojs("second = 2", id=7),
        )


def test_show_pinned_source_sets_renderer_option() -> None:
    notebook = obs.Notebook(
        obs.ojs("plain = 1", pinned=False),
        obs.ojs("answer = 42", pinned=True),
        show_pinned_source=True,
    )

    state = notebook_session(notebook).get_state(["_options", "_spec"])
    assert state["_options"] == {"show_source": True}
    assert [cell["pinned"] for cell in state["_spec"]["cells"]] == [False, True]


def test_notebook_kit_sources_sync_notebook_kit_runtime_profile() -> None:
    notebooks = [
        obs.Notebook(),
        obs.Notebook.from_html("<!doctype html><notebook></notebook>"),
    ]

    assert [
        notebook_session(notebook).get_state(["_runtime_profile"])
        for notebook in notebooks
    ] == [
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
        restored.update_variables({"require": "shadowed"})


def test_cell_notebookkit_attrs_reject_reserved_fields() -> None:
    with pytest.raises(ValueError, match="reserved fields: hidden, output"):
        obs.ojs(
            "answer = 42",
            output="answer",
            notebookkit_attrs=cast(
                Any,
                {"hidden": True, "output": "other"},
            ),
        )


def test_cell_and_helpers_share_one_first_class_schema() -> None:
    expected = obs.Cell(
        "answer = 42",
        mode="ojs",
        key="answer",
        display=False,
        raw=True,
        id=7,
        pinned=True,
        output="answer",
        notebookkit_attrs={"database": "duckdb"},
    )

    actual = obs.ojs(
        "answer = 42",
        key="answer",
        display=False,
        raw=True,
        id=7,
        pinned=True,
        output="answer",
        notebookkit_attrs={"database": "duckdb"},
    )

    assert actual == expected


def test_cell_validates_mode_and_attribute_collisions_at_construction() -> None:
    bad_mode: Any = "unknown"
    with pytest.raises(ValueError, match="Unsupported Observable cell mode"):
        obs.Cell("answer = 42", mode=bad_mode)

    with pytest.raises(ValueError, match="reserved fields: key, name"):
        obs.Cell(
            "answer = 42",
            key="answer",
            notebookkit_attrs=cast(Any, {"key": "other", "name": "answer"}),
        )


def test_cell_helpers_require_source_strings() -> None:
    source: Any = obs.ojs("answer = 42")

    with pytest.raises(TypeError, match="cell source must be a string"):
        obs.ojs(source)


@pytest.mark.parametrize("theme", obs.NOTEBOOK_THEMES)
def test_notebook_accepts_shipped_notebook_kit_themes(
    theme: obs.types.NotebookTheme,
    document_title: DocumentTitle,
) -> None:
    notebook = obs.Notebook(obs.ojs("answer = 42"), title="Demo", theme=theme)

    source = notebook.to_notebook_html()

    assert document_title(source) == "Demo"
    assert notebook.theme == theme
    assert f'<notebook theme="{theme}">' in source


def test_notebook_theme_mapping_normalizes_and_serializes() -> None:
    notebook = obs.Notebook(
        obs.ojs("answer = 42"),
        theme=cast(Any, {"light": " Cotton ", "dark": "Near-Midnight"}),
    )

    assert notebook.theme == {"light": "cotton", "dark": "near-midnight"}
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

    cast(Any, notebook).theme = "slate"

    assert notebook.theme == "slate"
    state = notebook_session(notebook).get_state(["theme", "_spec"])
    assert state["theme"] == "slate"
    assert state["_spec"]["theme"] == "slate"


def test_closed_notebook_rejects_theme_mutation() -> None:
    notebook = obs.Notebook(obs.ojs("answer = 42"), theme="air")
    notebook.close()

    with pytest.raises(RuntimeError, match="closed Notebook"):
        cast(Any, notebook).theme = "slate"

    assert notebook.theme == "air"
    assert '<notebook theme="air">' in notebook.to_notebook_html()


def test_source_backed_notebook_theme_trait_is_source_owned() -> None:
    source = """<!doctype html>
<notebook theme="coffee">
  <script id="1">answer = 42</script>
</notebook>
"""
    notebook = obs.Notebook.from_html(source)

    with pytest.raises(Exception, match="source HTML"):
        cast(Any, notebook).theme = {"light": "cotton", "dark": "slate"}

    assert notebook.theme == "coffee"
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
