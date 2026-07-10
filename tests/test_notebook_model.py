from __future__ import annotations

import observablejs as obs
from helpers import DocumentTitle, ScriptTags

from observablejs._model import (
    NotebookModel,
    NotebookNode,
    notebook_model_from_html,
    notebook_model_from_observablehq_page_data,
)


def test_notebook_model_serializes_python_authored_nodes(
    script_tags: ScriptTags,
) -> None:
    node = NotebookNode(
        id=7,
        value="answer = 42",
        mode="ojs",
        key="answer",
        pinned=True,
        output="answer",
    )
    model = NotebookModel(title="Demo", theme="air", nodes=(node,))

    assert model.spec == {
        "title": "Demo",
        "theme": "air",
        "cells": [
            {
                "id": 7,
                "value": "answer = 42",
                "mode": "ojs",
                "pinned": True,
                "output": "answer",
            }
        ],
    }
    [script] = script_tags(model.to_notebook_html())
    assert script["attrs"].get("id") == "7"
    assert script["attrs"].get("type") == "application/vnd.observable.javascript"
    assert "name" not in script["attrs"]
    assert script["text"].strip() == "answer = 42"


def test_html_model_preserves_source_and_exposes_cell_nodes() -> None:
    source = """<!doctype html>
<notebook theme="coffee">
  <script id="3" type="application/vnd.observable.javascript" name="answer">
    answer = 42
  </script>
</notebook>
"""

    model = notebook_model_from_html(
        source,
        files=None,
        base_path=None,
        embed_file_attachments=False,
        rewrite_imports=False,
    )

    assert model.source == source
    assert model.theme == "coffee"
    assert model.spec == {}
    assert model.runtime_compatibility == {}
    assert [node.to_spec() for node in model.nodes] == [
        {
            "id": 3,
            "value": "answer = 42",
            "mode": "ojs",
            "name": "answer",
        }
    ]


def test_observablehq_detail_data_model_accepts_nested_nodes_and_files(
    script_tags: ScriptTags,
) -> None:
    data = {
        "pageProps": {
            "initialNotebook": {
                "title": "Hosted",
                "nodes": [
                    {
                        "id": 1,
                        "mode": "md",
                        "value": "# Hosted",
                        "name": "",
                    },
                    {
                        "id": 2,
                        "mode": "js",
                        "value": 'data = FileAttachment("flare-2.json").json()',
                        "pinned": True,
                    },
                ],
                "files": [
                    {
                        "name": "flare-2.json",
                        "download_url": "https://static.example/flare-2.json",
                        "mime_type": "application/json",
                        "size": 123,
                        "create_time": "2019-10-29T22:33:05.252Z",
                    }
                ],
            }
        }
    }

    model = notebook_model_from_observablehq_page_data(data)

    assert model.title == "Hosted"
    assert model.attachments["flare-2.json"] == {
        "url": "https://static.example/flare-2.json",
        "mimeType": "application/json",
        "size": 123,
        "lastModified": 1572388385252,
    }
    assert [node.mode for node in model.nodes] == ["md", "ojs"]
    assert model.nodes[1].pinned is True
    assert script_tags(model.source)[1]["attrs"].get("type") == (
        "application/vnd.observable.javascript"
    )


def test_notebook_accepts_raw_observablehq_nodes_with_files(
    document_title: DocumentTitle,
    script_tags: ScriptTags,
) -> None:
    nodes = [
        {"id": 1, "mode": "js", "value": "answer = 42", "pinned": True},
    ]
    files = [
        {
            "name": "rows.csv",
            "download_url": "https://static.example/rows.csv",
            "mime_type": "text/csv",
        }
    ]

    notebook = obs.Notebook.from_observablehq_nodes(
        nodes,
        observable_files=files,
        title="Raw nodes",
        variables={"py_value": 7},
    )

    assert notebook.variables == {"py_value": 7}
    assert notebook.attachments["rows.csv"] == {
        "url": "https://static.example/rows.csv",
        "mimeType": "text/csv",
    }
    source = notebook.to_notebook_html()
    assert document_title(source) == "Raw nodes"
    [script] = script_tags(source)
    assert script["attrs"].get("type") == "application/vnd.observable.javascript"
    assert script["text"].strip() == "answer = 42"
