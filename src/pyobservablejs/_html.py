"""Notebook Kit HTML parsing."""

from __future__ import annotations

import textwrap
from html.parser import HTMLParser
from typing import Any, cast

from ._cells import Cell
from ._serialize import SCRIPT_TYPES, Mode
from ._themes import Theme, deserialize_theme_attribute


_MODE_BY_SCRIPT_TYPE = {
    script_type.lower(): mode for mode, script_type in SCRIPT_TYPES.items()
}


class _NotebookHTMLParser(HTMLParser):
    """Collect script cells from Notebook Kit HTML."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.cells: list[Cell] = []
        self.theme: Theme | None = None
        self._inside_notebook = False
        self._script_attrs: dict[str, str | None] | None = None
        self._script_parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if tag == "notebook":
            attrs_by_name = {name.lower(): value for name, value in attrs}
            if self.theme is None:
                self.theme = deserialize_theme_attribute(attrs_by_name.get("theme"))
            self._inside_notebook = True
            return
        if tag != "script" or not self._inside_notebook:
            return
        self._script_attrs = {name.lower(): value for name, value in attrs}
        self._script_parts = []

    def handle_data(self, data: str) -> None:
        if self._script_attrs is not None:
            self._script_parts.append(data)

    def handle_entityref(self, name: str) -> None:
        if self._script_attrs is not None:
            self._script_parts.append(f"&{name};")

    def handle_charref(self, name: str) -> None:
        if self._script_attrs is not None:
            self._script_parts.append(f"&#{name};")

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag == "notebook":
            self._inside_notebook = False
            return
        if tag != "script" or self._script_attrs is None:
            return
        attrs = self._script_attrs
        self._script_attrs = None
        value = (
            textwrap.dedent("".join(self._script_parts))
            .strip("\n")
            .replace("<\\/script", "</script")
        )
        cell_attrs: dict[str, Any] = {}
        cell_id = _optional_int(attrs.get("id"))
        if cell_id is not None:
            cell_attrs["id"] = cell_id
        for key in ("database", "format", "output"):
            if attrs.get(key) is not None:
                cell_attrs[key] = attrs[key]
        if "pinned" in attrs:
            cell_attrs["pinned"] = True
        self.cells.append(
            Cell(
                source=value,
                mode=cast(
                    Mode,
                    _MODE_BY_SCRIPT_TYPE.get(
                        (attrs.get("type") or "module").lower(), "ojs"
                    ),
                ),
                name=attrs.get("name"),
                display="hidden" not in attrs,
                raw=True,
                attrs=cell_attrs,
            )
        )


def parse_html_cells(source: str) -> list[Cell]:
    parser = _NotebookHTMLParser()
    parser.feed(source)
    return parser.cells


def parse_html_theme(source: str) -> Theme:
    parser = _NotebookHTMLParser()
    parser.feed(source)
    return parser.theme or "air"


def _optional_int(value: str | None) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except ValueError:
        return None
