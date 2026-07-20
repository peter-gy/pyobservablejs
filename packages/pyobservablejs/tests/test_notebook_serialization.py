from __future__ import annotations

import textwrap
from typing import Any

import observablejs as obs
from helpers import DocumentTitle, ObservableHQResponseInstaller, ScriptTags


def _notebook_from_observable_document(
    observablehq_response: ObservableHQResponseInstaller,
    document: dict[str, Any],
) -> obs.Notebook:
    observablehq_response(document)
    return obs.Notebook.from_observablehq("@example/notebook", timeout=1)


def test_observable_document_serializes_to_notebook_kit_html(
    observablehq_response: ObservableHQResponseInstaller,
    script_tags: ScriptTags,
    document_title: DocumentTitle,
) -> None:
    notebook = _notebook_from_observable_document(
        observablehq_response,
        {
            "title": "Remote Plot",
            "nodes": [
                {
                    "id": 0,
                    "mode": "md",
                    "value": "# Remote Plot",
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
        },
    )
    source = notebook.to_notebook_html()

    assert document_title(source) == "Remote Plot"
    scripts = script_tags(source)
    assert [script["attrs"].get("id") for script in scripts] == ["1", "3"]
    assert [script["attrs"].get("type") for script in scripts] == [
        "text/markdown",
        "application/vnd.observable.javascript",
    ]
    assert ["pinned" in script["attrs"] for script in scripts] == [False, True]
    assert scripts[0]["text"].strip() == "# Remote Plot"
    assert scripts[1]["text"].strip() == 'data = FileAttachment("data.csv").csv()'
    assert notebook.attachments == {
        "data.csv": {
            "url": "https://static.example/data.csv",
            "mimeType": "text/csv",
            "size": 12,
            "lastModified": 1779616800000,
        }
    }


def test_observable_document_js_nodes_become_ojs_cells(
    observablehq_response: ObservableHQResponseInstaller,
    script_tags: ScriptTags,
) -> None:
    markdown_source = "md`Imported notebook source`"
    notebook = _notebook_from_observable_document(
        observablehq_response,
        {
            "title": "Three.js basics",
            "nodes": [
                {
                    "id": 12,
                    "mode": "js",
                    "value": markdown_source,
                    "pinned": False,
                },
                {
                    "id": 5,
                    "mode": "js",
                    "value": 'THREE = require("three@0.119.1")',
                    "pinned": True,
                },
            ],
        },
    )

    scripts = script_tags(notebook.to_notebook_html())
    assert [item["attrs"]["type"] for item in scripts] == [
        "application/vnd.observable.javascript",
        "application/vnd.observable.javascript",
    ]
    assert ["pinned" in item["attrs"] for item in scripts] == [False, True]
    assert textwrap.dedent(scripts[0]["text"]).strip() == markdown_source
    assert scripts[1]["text"].strip() == 'THREE = require("three@0.119.1")'


def test_observable_document_preserves_notebook_kit_cell_modes(
    observablehq_response: ObservableHQResponseInstaller,
    script_tags: ScriptTags,
) -> None:
    notebook = _notebook_from_observable_document(
        observablehq_response,
        {
            "title": "Modes",
            "nodes": [
                {"id": 1, "mode": "tex", "value": "x^2"},
                {"id": 2, "mode": "dot", "value": "digraph { a -> b }"},
                {"id": 3, "mode": "ts", "value": "const answer: number = 42;"},
                {"id": 4, "mode": "node", "value": "return 42;"},
                {"id": 5, "mode": "python", "value": "answer = 42"},
                {"id": 6, "mode": "r", "value": "answer <- 42"},
            ],
        },
    )

    scripts = script_tags(notebook.to_notebook_html())

    assert [item["attrs"]["type"] for item in scripts] == [
        "application/x-tex",
        "text/vnd.graphviz",
        "text/x-typescript",
        "application/vnd.node.javascript",
        "text/x-python",
        "text/x-r",
    ]
    assert [item["text"].strip() for item in scripts] == [
        "x^2",
        "digraph { a -> b }",
        "const answer: number = 42;",
        "return 42;",
        "answer = 42",
        "answer <- 42",
    ]


def test_notebook_serializes_source_cells(
    script_tags: ScriptTags,
    document_title: DocumentTitle,
) -> None:
    widget = obs.Notebook(
        obs.md("# Title"),
        obs.js("const answer = 42;", output="answer"),
        obs.html("<p>Done</p>"),
        title="Demo",
    )

    source = widget.to_notebook_html()
    assert document_title(source) == "Demo"
    scripts = script_tags(source)
    assert [item["attrs"]["type"] for item in scripts] == [
        "text/markdown",
        "module",
        "text/html",
    ]
    assert scripts[0]["text"].strip() == "# Title"
    assert scripts[1]["text"].strip() == "const answer = 42;"
    assert scripts[1]["attrs"].get("output") == "answer"
    assert scripts[2]["text"].strip() == "<p>Done</p>"


def test_source_backed_notebooks_preserve_ojs_source(
    script_tags: ScriptTags,
) -> None:
    source = """<notebook>
  <script id="1" type="application/vnd.observable.javascript">md`Source text`</script>
</notebook>
"""

    from_html = obs.Notebook.from_html(source)
    authored = obs.Notebook(obs.ojs("md`Source text`"))

    for notebook in (from_html, authored):
        [script] = script_tags(notebook.to_notebook_html())
        assert script["attrs"]["type"] == "application/vnd.observable.javascript"
        assert script["text"].strip() == "md`Source text`"
