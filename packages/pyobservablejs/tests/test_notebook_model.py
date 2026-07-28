from __future__ import annotations

from typing import cast

import observablejs as obs
import pytest
from helpers import DocumentTitle, ScriptTags
from observablejs._model import (
    NotebookModel,
    NotebookNode,
    notebook_model_from_html,
    notebook_model_from_observablehq_document,
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
                "key": "answer",
                "pinned": True,
                "output": "answer",
            }
        ],
    }
    [script] = script_tags(model.to_notebook_html())
    assert script["attrs"].get("id") == "7"
    assert script["attrs"].get("type") == "application/vnd.observable.javascript"
    assert script["attrs"].get("data-pyobservablejs-key") == "answer"
    assert "name" not in script["attrs"]
    assert script["text"].strip() == "answer = 42"


def test_notebook_model_rejects_name_identity_metadata() -> None:
    with pytest.raises(ValueError, match="use key for public identity"):
        NotebookNode.from_spec(
            {
                "id": 1,
                "value": "answer = 42",
                "mode": "ojs",
                "name": "answer",
            }
        )


def test_notebook_node_rejects_non_integer_id() -> None:
    with pytest.raises(TypeError, match="Notebook cell id must be an integer"):
        NotebookNode.from_spec({"id": True})


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
    assert [node.to_spec() for node in model.nodes] == [
        {
            "id": 3,
            "value": "answer = 42",
            "mode": "ojs",
        }
    ]


def test_html_model_normalizes_cell_ids_like_notebook_kit() -> None:
    source = """<!doctype html>
<notebook>
  <script>first = 1</script>
  <script id="2">second = 2</script>
  <script id="2">third = 3</script>
  <script id="-1">fourth = 4</script>
  <script id="4.9">fifth = 5</script>
</notebook>
"""

    model = notebook_model_from_html(
        source,
        files=None,
        base_path=None,
        embed_file_attachments=False,
        rewrite_imports=False,
    )

    assert [node.id for node in model.nodes] == [1, 2, 3, 4, 5]


@pytest.mark.parametrize(
    ("source_id", "expected_ids"),
    [
        ("1_0", [1, 2]),
        ("９", [1, 2]),
        ("\u00859\u0085", [1, 2]),
        ("\ufeff2\ufeff", [2, 3]),
        ("0x10", [16, 17]),
        ("0b10", [2, 3]),
        ("0o10", [8, 9]),
        ("+0x10", [1, 2]),
        ("077", [77, 78]),
        ("1.9", [1, 2]),
        (".5", [1, 2]),
        ("1e3", [1000, 1001]),
        ("Infinity", [1, 2]),
        ("1e309", [1, 2]),
    ],
)
def test_html_model_matches_ecmascript_number_for_cell_ids(
    source_id: str,
    expected_ids: list[int],
) -> None:
    source = f"""<notebook>
<script id="{source_id}">first = 1</script>
<script>second = 2</script>
</notebook>"""

    model = notebook_model_from_html(
        source,
        files=None,
        base_path=None,
        embed_file_attachments=False,
        rewrite_imports=False,
    )

    assert [node.id for node in model.nodes] == expected_ids


def test_html_model_rejects_ids_above_the_javascript_safe_range() -> None:
    source = "<notebook><script id='9007199254740992'>answer = 42</script></notebook>"

    with pytest.raises(ValueError, match="between 1 and 9007199254740991"):
        notebook_model_from_html(
            source,
            files=None,
            base_path=None,
            embed_file_attachments=False,
            rewrite_imports=False,
        )


def test_observablehq_document_model_accepts_nodes_and_files(
    script_tags: ScriptTags,
) -> None:
    document = {
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

    model = notebook_model_from_observablehq_document(
        cast(obs.types.ObservableDocument, document)
    )

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


def test_observablehq_document_assigns_unused_ids_to_invalid_inputs() -> None:
    document = {
        "nodes": [
            {"mode": "md", "value": "first"},
            {"id": 1, "mode": "md", "value": "second"},
            {"id": 0, "mode": "md", "value": "third"},
            {"id": "-2", "mode": "md", "value": "fourth"},
            {"id": "missing", "mode": "md", "value": "fifth"},
        ]
    }

    model = notebook_model_from_observablehq_document(
        cast(obs.types.ObservableDocument, document)
    )

    assert [node.id for node in model.nodes] == [2, 1, 3, 4, 5]


@pytest.mark.parametrize("cell_id", ["1_0", "９", "\u00859\u0085", "1.5", "1e2"])
def test_observablehq_document_falls_back_for_non_ascii_integer_ids(
    cell_id: str,
) -> None:
    document = {
        "nodes": [
            {"id": cell_id, "mode": "md", "value": "fallback"},
            {"id": 2, "mode": "md", "value": "explicit"},
        ]
    }

    model = notebook_model_from_observablehq_document(
        cast(obs.types.ObservableDocument, document)
    )

    assert [node.id for node in model.nodes] == [1, 2]


@pytest.mark.parametrize("cell_id", [9007199254740992, "9007199254740992"])
def test_observablehq_document_rejects_unsafe_explicit_ids(
    cell_id: int | str,
) -> None:
    document = {"nodes": [{"id": cell_id, "mode": "md", "value": "unsafe"}]}

    with pytest.raises(ValueError, match="between 1 and 9007199254740991"):
        notebook_model_from_observablehq_document(
            cast(obs.types.ObservableDocument, document)
        )


def test_observablehq_document_rejects_oversized_decimal_strings() -> None:
    document = {"nodes": [{"id": "9" * 5000, "mode": "md", "value": "unsafe"}]}

    with pytest.raises(ValueError, match="between 1 and 9007199254740991"):
        notebook_model_from_observablehq_document(
            cast(obs.types.ObservableDocument, document)
        )


def test_observablehq_document_rejects_duplicate_explicit_ids() -> None:
    document = {
        "nodes": [
            {"id": 7, "mode": "md", "value": "first"},
            {"id": "7", "mode": "md", "value": "second"},
        ]
    }

    with pytest.raises(ValueError, match="Notebook cell ids must be unique: 7"):
        notebook_model_from_observablehq_document(
            cast(obs.types.ObservableDocument, document)
        )


def test_notebook_accepts_observablehq_document_nodes_with_files(
    document_title: DocumentTitle,
    script_tags: ScriptTags,
) -> None:
    nodes: list[obs.types.ObservableNode] = [
        {"id": 1, "mode": "js", "value": "answer = 42", "pinned": True},
    ]
    files: list[obs.types.ObservableFile] = [
        {
            "name": "rows.csv",
            "download_url": "https://static.example/rows.csv",
            "mime_type": "text/csv",
        }
    ]

    notebook = obs.Notebook.from_observablehq_document(
        {"nodes": nodes, "files": files, "title": "Raw nodes"},
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
