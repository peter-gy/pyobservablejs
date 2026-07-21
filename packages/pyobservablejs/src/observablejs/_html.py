"""Notebook Kit HTML parsing."""

from __future__ import annotations

import math
import re
import textwrap
from html.parser import HTMLParser
from typing import Any, cast

from ._cell_ids import _MAX_SAFE_CELL_ID
from ._cells import Cell
from ._serialize import (
    CELL_KEY_ATTRIBUTE,
    RUNTIME_PROFILE_ATTRIBUTE,
    SCRIPT_TYPES,
    Mode,
    RuntimeProfile,
)
from ._themes import Theme, deserialize_theme_attribute
from .types import NotebookKitCellMetadata


_MODE_BY_SCRIPT_TYPE = {
    script_type.lower(): mode for mode, script_type in SCRIPT_TYPES.items()
}
_ECMASCRIPT_TRIM = (
    "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680"
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000\ufeff"
)
_ECMASCRIPT_DECIMAL = re.compile(
    r"[+-]?(?:Infinity|(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)"
)
_ECMASCRIPT_NON_DECIMAL = (
    (re.compile(r"0[xX][0-9a-fA-F]+"), 16),
    (re.compile(r"0[bB][01]+"), 2),
    (re.compile(r"0[oO][0-7]+"), 8),
)


class _NotebookHTMLParser(HTMLParser):
    """Collect script cells from Notebook Kit HTML."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.cells: list[Cell] = []
        self.theme: Theme | None = None
        self.runtime_profile: RuntimeProfile | None = None
        self._inside_notebook = False
        self._script_attrs: dict[str, str | None] | None = None
        self._script_parts: list[str] = []
        self._max_cell_id = 0
        self._cell_ids: set[int] = set()

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if tag == "notebook":
            attrs_by_name = {name.lower(): value for name, value in attrs}
            if self.theme is None:
                self.theme = deserialize_theme_attribute(attrs_by_name.get("theme"))
                self.runtime_profile = _runtime_profile(
                    attrs_by_name.get(RUNTIME_PROFILE_ATTRIBUTE)
                )
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
        cell_id = self._cell_id(attrs.get("id"))
        for key in ("database", "format", "since"):
            if attrs.get(key) is not None:
                cell_attrs[key] = attrs[key]
        self.cells.append(
            Cell(
                source=value,
                mode=cast(
                    Mode,
                    _MODE_BY_SCRIPT_TYPE.get(
                        (attrs.get("type") or "module").lower(), "ojs"
                    ),
                ),
                key=attrs.get(CELL_KEY_ATTRIBUTE),
                display="hidden" not in attrs,
                raw=True,
                id=cell_id,
                pinned="pinned" in attrs,
                output=attrs.get("output"),
                notebookkit_attrs=cast(NotebookKitCellMetadata, cell_attrs),
            )
        )

    def _cell_id(self, value: str | None) -> int:
        cell_id = _notebook_kit_cell_id(value)
        if cell_id is None or cell_id in self._cell_ids:
            if self._max_cell_id >= _MAX_SAFE_CELL_ID:
                raise ValueError("Notebook has no available JavaScript-safe cell id")
            self._max_cell_id += 1
            cell_id = self._max_cell_id
        elif cell_id > self._max_cell_id:
            self._max_cell_id = cell_id
        self._cell_ids.add(cell_id)
        return cell_id


def parse_html_cells(source: str) -> list[Cell]:
    parser = _NotebookHTMLParser()
    parser.feed(source)
    return parser.cells


def parse_html_theme(source: str) -> Theme:
    parser = _NotebookHTMLParser()
    parser.feed(source)
    return parser.theme or "air"


def parse_html_runtime_profile(source: str) -> RuntimeProfile:
    parser = _NotebookHTMLParser()
    parser.feed(source)
    return parser.runtime_profile or "notebook-kit"


def _runtime_profile(value: str | None) -> RuntimeProfile:
    if value is None or value == "notebook-kit":
        return "notebook-kit"
    if value == "observable":
        return "observable"
    raise ValueError(f"Unsupported pyobservablejs runtime profile: {value!r}")


def _notebook_kit_cell_id(value: str | None) -> int | None:
    normalized = "" if value is None else value.strip(_ECMASCRIPT_TRIM)
    if not normalized:
        return None
    if _ECMASCRIPT_DECIMAL.fullmatch(normalized):
        number = float(normalized)
    else:
        for pattern, base in _ECMASCRIPT_NON_DECIMAL:
            if pattern.fullmatch(normalized):
                try:
                    number = float(int(normalized[2:], base))
                except OverflowError:
                    return None
                break
        else:
            return None
    if not math.isfinite(number):
        return None
    cell_id = math.floor(number)
    if cell_id <= 0:
        return None
    if cell_id > _MAX_SAFE_CELL_ID:
        raise ValueError(f"Notebook cell id must be between 1 and {_MAX_SAFE_CELL_ID}")
    return cell_id
