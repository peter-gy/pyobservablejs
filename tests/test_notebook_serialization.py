from __future__ import annotations

from html.parser import HTMLParser
from typing import Any

import pyobservablejs as obs
import pytest
from pyobservablejs._observable import observable_document_to_html


class _ScriptParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.scripts: list[dict[str, Any]] = []
        self._attrs: dict[str, str | None] | None = None
        self._parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() != "script":
            return
        self._attrs = {name.lower(): value for name, value in attrs}
        self._parts = []

    def handle_data(self, data: str) -> None:
        if self._attrs is not None:
            self._parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() != "script" or self._attrs is None:
            return
        self.scripts.append(
            {
                "attrs": self._attrs,
                "text": "".join(self._parts),
            }
        )
        self._attrs = None
        self._parts = []


def _script_tags(source: str) -> list[dict[str, Any]]:
    parser = _ScriptParser()
    parser.feed(source)
    return parser.scripts


class _TitleParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title = ""
        self._in_title = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        del attrs
        if tag.lower() == "title":
            self._in_title = True

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title += data

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "title":
            self._in_title = False


def _document_title(source: str) -> str:
    parser = _TitleParser()
    parser.feed(source)
    return parser.title


def test_observable_document_serializes_to_notebook_kit_html() -> None:
    source, attachments = observable_document_to_html(
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
        }
    )

    assert _document_title(source) == "Remote Plot"
    scripts = _script_tags(source)
    assert [script["attrs"].get("id") for script in scripts] == ["0", "3"]
    assert [script["attrs"].get("type") for script in scripts] == [
        "text/markdown",
        "application/vnd.observable.javascript",
    ]
    assert ["pinned" in script["attrs"] for script in scripts] == [False, True]
    assert scripts[0]["text"].strip() == "# Remote Plot"
    assert scripts[1]["text"].strip() == 'data = FileAttachment("data.csv").csv()'
    assert attachments == {
        "data.csv": {
            "url": "https://static.example/data.csv",
            "mimeType": "text/csv",
            "size": 12,
            "lastModified": 1779616800000,
        }
    }


def test_observable_document_js_nodes_become_ojs_cells() -> None:
    source, attachments = observable_document_to_html(
        {
            "title": "Three.js basics",
            "nodes": [
                {
                    "id": 12,
                    "mode": "js",
                    "value": """md`** 1. Import the library**

Version 119.1 was the latest when this notebook was written.`""",
                    "pinned": False,
                },
                {
                    "id": 5,
                    "mode": "js",
                    "value": 'THREE = require("three@0.119.1")',
                    "pinned": True,
                },
            ],
        }
    )

    assert attachments == {}
    scripts = _script_tags(source)
    assert [item["attrs"]["type"] for item in scripts] == [
        "application/vnd.observable.javascript",
        "application/vnd.observable.javascript",
    ]
    assert [item["attrs"]["id"] for item in scripts] == ["12", "5"]
    assert ["pinned" in item["attrs"] for item in scripts] == [False, True]
    assert "md`** 1. Import the library**" in scripts[0]["text"]
    assert 'THREE = require("three@0.119.1")' in scripts[1]["text"]


def test_notebook_serializes_source_cells() -> None:
    widget = obs.Notebook(
        obs.md("# Title"),
        obs.js("const answer = 42;", output="answer"),
        title="Demo",
    )

    assert widget.spec["title"] == "Demo"
    assert widget.spec["cells"][0]["mode"] == "md"
    assert widget.spec["cells"][1]["mode"] == "js"
    assert widget.spec["cells"][1]["output"] == "answer"
    scripts = _script_tags(widget.to_notebook_html())
    assert [item["attrs"]["type"] for item in scripts] == ["text/markdown", "module"]


def test_observablehq_notebooks_enable_hosted_markdown_compatibility(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fake_fetch(
        specifier: str, *, timeout: float | None
    ) -> tuple[str, dict[str, dict[str, Any]]]:
        assert specifier == "@example/notebook"
        assert timeout == 1
        return (
            """<notebook>
  <script id="1" type="application/vnd.observable.javascript">md`** Heading**`</script>
</notebook>
""",
            {},
        )

    monkeypatch.setattr(
        "pyobservablejs._notebook.fetch_observablehq_notebook", fake_fetch
    )

    notebook = obs.Notebook.from_observablehq("@example/notebook", timeout=1)

    assert notebook.options["observable_markdown_compatibility"] is True


def test_source_backed_notebooks_keep_notebook_kit_markdown_contract() -> None:
    source = """<notebook>
  <script id="1" type="application/vnd.observable.javascript">md`** Heading**`</script>
</notebook>
"""

    notebook = obs.Notebook.from_html(source)
    authored = obs.Notebook(obs.ojs("md`** Heading**`"))

    assert notebook.options["observable_markdown_compatibility"] is False
    assert authored.options["observable_markdown_compatibility"] is False
