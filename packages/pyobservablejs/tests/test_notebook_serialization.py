from __future__ import annotations

from typing import Any

import observablejs as obs
import pytest
from helpers import DocumentTitle, ObservableHQResponseInstaller, ScriptTags


@pytest.mark.parametrize(
    "source",
    [
        "content = String.raw`</ScRiPt></SCRIPT>`",
        r"content = String.raw`<\/script>`",
        r"content = String.raw`<\\/SCRIPT >`",
        "content = String.raw`first\u2028second`",
    ],
)
def test_html_roundtrip_preserves_literal_script_text(source: str) -> None:
    notebook = obs.Notebook(obs.ojs(source, key="content", raw=True))
    restored = obs.Notebook.from_html(notebook.to_notebook_html())
    assert restored.cell("content").source == source
    restored.close()
    notebook.close()


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
                    "create_time": "2026-05-24T10:00:00.252Z",
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
            "lastModified": 1779616800252,
        }
    }


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


def test_sql_view_cells_round_trip_through_notebook_html(
    script_tags: ScriptTags,
) -> None:
    notebook = obs.Notebook(
        obs.Cell(
            "SELECT * FROM rows",
            mode="sql.view",
            key="query",
            output="query",
            notebookkit_attrs={"database": "var:db"},
        )
    )
    source = notebook.to_notebook_html()
    restored = obs.Notebook.from_html(source)
    script = script_tags(restored.to_notebook_html())[0]

    assert script["attrs"]["type"] == "application/sql+view"
    assert script["attrs"]["database"] == "var:db"
    assert script["attrs"]["output"] == "query"
    assert script["text"].strip() == "SELECT * FROM rows"
    assert restored.cell("query").key == "query"
