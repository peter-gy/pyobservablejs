from __future__ import annotations

import json
from collections.abc import Sequence
from html.parser import HTMLParser
from typing import Any, cast

import pytest
import observablejs as obs
from helpers import (
    BrowserGraphCell,
    BrowserGraphCellBuilder,
    BrowserGraphSync,
    BrowserValueSync,
    CommentNodes,
    DocumentTitle,
    ObservableHQResponseInstaller,
    ScriptTags,
)


class _ScriptParser(HTMLParser):
    def __init__(self, *, notebook_only: bool = False) -> None:
        super().__init__(convert_charrefs=True)
        self._notebook_only = notebook_only
        self._notebook_depth = 0
        self.scripts: list[dict[str, Any]] = []
        self._attrs: dict[str, str | None] | None = None
        self._parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if tag == "notebook" and self._attrs is None:
            self._notebook_depth += 1
            return
        if tag != "script":
            return
        if self._notebook_only and self._notebook_depth == 0:
            return
        self._attrs = {name.lower(): value for name, value in attrs}
        self._parts = []

    def handle_data(self, data: str) -> None:
        if self._attrs is not None:
            self._parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag == "notebook" and self._attrs is None and self._notebook_depth:
            self._notebook_depth -= 1
            return
        if tag != "script" or self._attrs is None:
            return
        self.scripts.append({"attrs": self._attrs, "text": "".join(self._parts)})
        self._attrs = None
        self._parts = []


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


class _CommentParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.comments: list[str] = []

    def handle_comment(self, data: str) -> None:
        self.comments.append(data)


class _ObservableHQResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload

    def __enter__(self) -> "_ObservableHQResponse":
        return self

    def __exit__(self, *_args: object) -> bool:
        return False

    def read(self) -> bytes:
        return json.dumps(self._payload).encode("utf-8")


@pytest.fixture
def observablehq_response(
    monkeypatch: pytest.MonkeyPatch,
) -> ObservableHQResponseInstaller:
    def install(document: dict[str, Any]) -> list[tuple[str, float | None]]:
        requests: list[tuple[str, float | None]] = []

        def fake_urlopen(request: Any, *, timeout: float | None = None) -> Any:
            url = request if isinstance(request, str) else request.get_full_url()
            requests.append((url, timeout))
            return _ObservableHQResponse(document)

        monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
        return requests

    return install


@pytest.fixture
def browser_graph_sync() -> BrowserGraphSync:
    def sync(
        widget: Any,
        cells: Sequence[BrowserGraphCell],
        edges: Sequence[tuple[str, str, str]] = (),
    ) -> None:
        cell_ids = {
            cell.key: cell.id if cell.id is not None else index + 1
            for index, cell in enumerate(cells)
        }
        _sync_browser_readback(
            widget,
            graph={
                "cells": [
                    _browser_graph_cell(index=index, id=index + 1, cell=cell)
                    for index, cell in enumerate(cells)
                ],
                "edges": [
                    {
                        "from": cell_ids[source],
                        "to": cell_ids[target],
                        "variable": variable,
                    }
                    for source, target, variable in edges
                ],
            },
        )

    return sync


@pytest.fixture
def browser_graph_cell() -> BrowserGraphCellBuilder:
    def build(
        key: str,
        *,
        id: int | None = None,
        index: int | None = None,
        name: str | None = None,
        defines: Sequence[str] = (),
        references: Sequence[str] = (),
        output: str | None = None,
        runtime_outputs: Sequence[str] = (),
    ) -> BrowserGraphCell:
        return BrowserGraphCell(
            key=key,
            id=id,
            index=index,
            name=name,
            defines=tuple(defines),
            references=tuple(references),
            output=output,
            runtime_outputs=tuple(runtime_outputs),
        )

    return build


@pytest.fixture
def browser_value_sync() -> BrowserValueSync:
    def sync(
        view: obs.NotebookView,
        values: dict[str, Any],
        value_names: Sequence[str] | None = None,
        *,
        index: int = 0,
    ) -> None:
        current = cast(dict[str, Any], view._readback)
        graph = (
            cast(dict[str, Any], current["graph"])
            if view.has_graph_snapshot
            else {"cells": [], "edges": []}
        )
        records = dict(cast(dict[str, Any], current["cells"]))
        records[str(index)] = {
            "rendered": True,
            "names": list(value_names if value_names is not None else values),
            "values": values,
        }
        _sync_browser_readback(view, rendered=True, graph=graph, cells=records)

    return sync


def _sync_browser_readback(
    view: obs.NotebookView,
    *,
    rendered: bool | None = None,
    graph: dict[str, Any] | None = None,
    cells: dict[str, Any] | None = None,
) -> None:
    current = cast(dict[str, Any], view._readback)
    view.set_trait(
        "_readback",
        {
            "revision": current["revision"] + 1,
            "rendered": current["rendered"] if rendered is None else rendered,
            "graph": current["graph"] if graph is None else graph,
            "cells": current["cells"] if cells is None else cells,
        },
    )


def _browser_graph_cell(
    *,
    id: int,
    index: int,
    cell: BrowserGraphCell,
) -> dict[str, Any]:
    raw: dict[str, Any] = {
        "id": cell.id if cell.id is not None else id,
        "index": cell.index if cell.index is not None else index,
        "key": cell.key,
        "mode": "ojs",
        "defines": list(cell.defines),
    }
    if cell.name is not None:
        raw["name"] = cell.name
    if cell.references:
        raw["references"] = list(cell.references)
    if cell.output is not None:
        raw["output"] = cell.output
    if cell.runtime_outputs:
        raw["runtime_outputs"] = list(cell.runtime_outputs)
    return raw


@pytest.fixture
def script_tags() -> ScriptTags:
    def parse(source: str) -> list[dict[str, Any]]:
        parser = _ScriptParser(notebook_only=True)
        parser.feed(source)
        return parser.scripts

    return parse


@pytest.fixture
def all_script_tags() -> ScriptTags:
    def parse(source: str) -> list[dict[str, Any]]:
        parser = _ScriptParser()
        parser.feed(source)
        return parser.scripts

    return parse


@pytest.fixture
def document_title() -> DocumentTitle:
    def parse(source: str) -> str:
        parser = _TitleParser()
        parser.feed(source)
        return parser.title

    return parse


@pytest.fixture
def comment_nodes() -> CommentNodes:
    def parse(source: str) -> list[str]:
        parser = _CommentParser()
        parser.feed(source)
        return parser.comments

    return parse
