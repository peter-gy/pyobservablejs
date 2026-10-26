from __future__ import annotations

from typing import Literal

import observablejs as obs
import pytest


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


def test_lossy_document_names_its_lost_cell_languages():
    with pytest.raises(ValueError, match="lost its original cell languages: ts"):
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
