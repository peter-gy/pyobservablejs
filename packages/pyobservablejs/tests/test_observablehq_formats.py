from __future__ import annotations

import io
import json
from typing import Any, Literal

import observablejs as obs
import pytest


def _page(
    metadata: dict[str, Any],
    body: dict[str, Any],
    text: str,
    revision: int | None = None,
) -> str:
    metadata = {**metadata, "body": "$3"}
    body = {**body, "cells": [{"id": 0, "mode": "ts", "value": "$4"}], "files": "$W5"}
    chunks = (
        "0:"
        + json.dumps(
            [
                "$",
                "$L1",
                None,
                {
                    "metaPromise": "$@2",
                    "bodyPromise": "$@3",
                    "version": revision if revision is not None else "$undefined",
                },
            ]
        )
        + "\n"
        + '1:I[1,[],"NotebookClient"]\n'
        + f"2:{json.dumps(metadata)}\n3:{json.dumps(body)}\n"
        + f"4:T{len(text.encode('utf-8')):x},{text}"
        + "5:[]\n"
    )
    middle = len(chunks) // 2
    return "".join(
        f"<script>self.__next_f.push({json.dumps([1, chunk])})</script>"
        for chunk in (chunks[:middle], chunks[middle:])
    )


def test_public_source_retains_native_cell_language_and_unicode(
    monkeypatch: pytest.MonkeyPatch,
):
    text = 'const title: string = "🌍 héllo";\nconst dollars = "$2";'
    source = _page(
        {"id": "0123456789abcdef", "version": 7},
        {"stdlib": "2", "title": "Native"},
        text,
    )
    monkeypatch.setattr(
        "urllib.request.urlopen", lambda *_args, **_kwargs: io.BytesIO(source.encode())
    )
    view = obs.view_from_observablehq("0123456789abcdef@7")
    try:
        assert view.cells[0].source == text
        assert view.cells[0].mode == "ts"
        assert view.notebook.runtime_profile == "notebook-kit"
        assert view.notebook.source_document is not None
        assert view.notebook.source_document["version"] == 7
    finally:
        view.close()
    with pytest.raises(ValueError, match="different notebook revision"):
        obs.view_from_observablehq("0123456789abcdef@8")


@pytest.mark.parametrize("stdlib,profile", [("1", "observable"), ("2", "notebook-kit")])
def test_native_document_languages_are_independent_of_library(
    stdlib: Literal["1", "2"], profile: str
):
    document: obs.types.ObservableDocument = {
        "body": {
            "stdlib": stdlib,
            "cells": [
                {"id": 0, "mode": "js", "value": "const x = 1;"},
                {"id": 1, "mode": "ojs", "value": "y = 2"},
                {"id": 2, "mode": "ts", "value": "const z: number = 3;"},
            ],
            "files": [
                {
                    "name": "data.csv",
                    "href": "https://example.test/data.csv",
                    "type": "text/csv",
                    "lastModified": 12.75,
                    "size": 12,
                }
            ],
        }
    }
    notebook = obs.Notebook.from_observablehq_document(document)
    restored = obs.Notebook.from_html(notebook.to_notebook_html())
    try:
        assert [cell.mode for cell in notebook.cells] == ["js", "ojs", "ts"]
        assert [cell.mode for cell in restored.cells] == ["js", "ojs", "ts"]
        assert len({cell.id for cell in notebook.cells}) == 3
        assert notebook.cells.keys() == ("cell-3", "cell-1", "cell-2")
        assert restored.cells.keys() == notebook.cells.keys()
        assert notebook.cells["cell-3"] is notebook.cells[0]
        assert notebook.runtime_profile == profile
        assert restored.runtime_profile == profile
        assert (
            notebook.state.attachments["data.csv"]["url"]
            == "https://example.test/data.csv"
        )
        assert notebook.state.attachments["data.csv"]["lastModified"] == 12
    finally:
        restored.close()
        notebook.close()


def test_supplied_lossy_document_requires_original_source():
    with pytest.raises(ValueError, match="lost its original cell languages"):
        obs.Notebook.from_observablehq_document(
            {
                "nodes": [{"id": 1, "mode": "js", "value": "const x = 1;"}],
                "resolutions": [
                    {"type": "unsupported_mode", "specifier": "ts", "value": "js"}
                ],
            }
        )


@pytest.mark.parametrize(
    ("document", "message"),
    [
        (
            {
                "cells": [{"id": 0, "mode": "js", "value": "const x = 1;"}],
                "files": [{}],
            },
            "file name must be a nonempty string",
        ),
        (
            {
                "nodes": [],
                "resolutions": [{"type": "notebook", "specifier": "@example/value"}],
            },
            "resolution type, specifier, and value must be strings",
        ),
        (
            {"cells": [{"id": 0, "mode": "js", "value": 1}]},
            "cell value must be a string",
        ),
    ],
)
def test_observable_document_records_are_validated(document, message: str):
    with pytest.raises(TypeError, match=message):
        obs.Notebook.from_observablehq_document(document)


def test_public_revision_uses_rendered_body_version(monkeypatch: pytest.MonkeyPatch):
    source = _page(
        {"id": "0123456789abcdef", "version": 9},
        {"stdlib": "2"},
        "const value = 4;",
        revision=4,
    )
    monkeypatch.setattr(
        "urllib.request.urlopen", lambda *_args, **_kwargs: io.BytesIO(source.encode())
    )
    notebook = obs.Notebook.from_observablehq("0123456789abcdef@4")
    try:
        assert notebook.source_document is not None
        assert notebook.source_document["version"] == 4
        assert notebook.source_document["latest_version"] == 9
    finally:
        notebook.close()


def test_classic_next_page_payload(monkeypatch: pytest.MonkeyPatch):
    payload = {
        "props": {
            "pageProps": {
                "initialNotebook": {
                    "nodes": [{"id": 0, "mode": "js", "value": "answer = 42"}]
                }
            }
        }
    }
    source = f'<script id="__NEXT_DATA__" type="application/json">{json.dumps(payload)}</script>'
    monkeypatch.setattr(
        "urllib.request.urlopen", lambda *_args, **_kwargs: io.BytesIO(source.encode())
    )
    notebook = obs.Notebook.from_observablehq("@example/classic")
    try:
        assert notebook.cells[0].mode == "ojs"
        assert notebook.cells[0].source == "answer = 42"
    finally:
        notebook.close()


def test_flight_reference_cache_preserves_projections_and_response_isolation(
    monkeypatch,
    document_title,
):
    for text in ("$literal", "🌍 second response"):
        source = _page(
            {"id": "0123456789abcdef", "version": 7, "description": "$3:title"},
            {"stdlib": "2", "title": "$4"},
            text,
        )
        monkeypatch.setattr(
            "urllib.request.urlopen",
            lambda *_args, _source=source, **_kwargs: io.BytesIO(_source.encode()),
        )
        notebook = obs.Notebook.from_observablehq("0123456789abcdef@7")
        try:
            assert document_title(notebook.to_notebook_html()) == text
            assert notebook.cells[0].source == text
            assert notebook.source_document is not None
            assert notebook.source_document["description"] == text
        finally:
            notebook.close()


def test_flight_rejects_cyclic_source_references(monkeypatch):
    source = _page(
        {"id": "0123456789abcdef", "version": 7}, {"title": "$3:title"}, "x = 1"
    )
    monkeypatch.setattr(
        "urllib.request.urlopen", lambda *_args, **_kwargs: io.BytesIO(source.encode())
    )
    with pytest.raises(ValueError, match="Cyclic ObservableHQ source reference"):
        obs.Notebook.from_observablehq("0123456789abcdef@7")
