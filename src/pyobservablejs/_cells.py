"""Authored Observable cell helpers."""

from __future__ import annotations

import dataclasses
import textwrap
from collections.abc import Mapping
from typing import Any

from ._serialize import AUTHOR_MODES, SCRIPT_TYPES, AuthorMode, Mode


@dataclasses.dataclass(frozen=True)
class Cell:
    """Notebook Kit cell authored from Python source.

    Source strings are dedented and stripped of leading or trailing newlines
    unless ``raw=True``. ``to_spec`` returns the JSON shape consumed by Notebook
    Kit and by the bundled anywidget renderer.
    """

    source: str
    mode: Mode = "ojs"
    name: str | None = None
    display: bool = True
    raw: bool = False
    attrs: Mapping[str, Any] = dataclasses.field(default_factory=dict)

    def __post_init__(self) -> None:
        if not isinstance(self.source, str):
            raise TypeError("cell source must be a string")
        if self.raw:
            return
        source = textwrap.dedent(self.source).strip("\n")
        object.__setattr__(self, "source", source)

    def to_spec(self, id: int) -> dict[str, Any]:
        """Return this cell in Notebook Kit's JSON cell shape."""

        if self.mode not in SCRIPT_TYPES:
            raise ValueError(f"Unsupported Observable cell mode: {self.mode!r}")
        attrs = dict(self.attrs)
        spec: dict[str, Any] = {
            "id": attrs.pop("id", id),
            "value": self.source,
            "mode": self.mode,
        }
        if self.name is not None:
            spec["name"] = self.name
        if not self.display:
            spec["hidden"] = True
        for key, value in attrs.items():
            if value is not None:
                spec[key] = value
        return spec


CellInput = str | Cell


def ojs(
    source: CellInput,
    *,
    name: str | None = None,
    display: bool = True,
    raw: bool = False,
    id: int | None = None,
    pinned: bool = False,
    output: str | None = None,
    attrs: Mapping[str, Any] | None = None,
) -> Cell:
    """Return an Observable JavaScript source cell."""

    return _source_cell(
        source,
        mode="ojs",
        name=name,
        display=display,
        raw=raw,
        id=id,
        pinned=pinned,
        output=output,
        attrs=attrs,
    )


def js(
    source: CellInput,
    *,
    name: str | None = None,
    display: bool = True,
    raw: bool = False,
    id: int | None = None,
    pinned: bool = False,
    output: str | None = None,
    attrs: Mapping[str, Any] | None = None,
) -> Cell:
    """Return a standard JavaScript module source cell."""

    return _source_cell(
        source,
        mode="js",
        name=name,
        display=display,
        raw=raw,
        id=id,
        pinned=pinned,
        output=output,
        attrs=attrs,
    )


def md(
    source: CellInput,
    *,
    name: str | None = None,
    display: bool = True,
    raw: bool = False,
    id: int | None = None,
    pinned: bool = False,
    output: str | None = None,
    attrs: Mapping[str, Any] | None = None,
) -> Cell:
    """Return a Markdown source cell."""

    return _source_cell(
        source,
        mode="md",
        name=name,
        display=display,
        raw=raw,
        id=id,
        pinned=pinned,
        output=output,
        attrs=attrs,
    )


def html(
    source: CellInput,
    *,
    name: str | None = None,
    display: bool = True,
    raw: bool = False,
    id: int | None = None,
    pinned: bool = False,
    output: str | None = None,
    attrs: Mapping[str, Any] | None = None,
) -> Cell:
    """Return an HTML source cell."""

    return _source_cell(
        source,
        mode="html",
        name=name,
        display=display,
        raw=raw,
        id=id,
        pinned=pinned,
        output=output,
        attrs=attrs,
    )


def _source_cell(
    source: CellInput,
    *,
    mode: Mode,
    name: str | None = None,
    display: bool = True,
    raw: bool = False,
    id: int | None = None,
    pinned: bool = False,
    output: str | None = None,
    attrs: Mapping[str, Any] | None = None,
) -> Cell:
    if isinstance(source, Cell):
        if any(
            [
                name is not None,
                display is not True,
                mode != source.mode,
                raw,
                id is not None,
                pinned,
                output is not None,
                attrs,
            ]
        ):
            raise TypeError("Cannot override an existing Cell")
        return source
    if not isinstance(source, str):
        raise TypeError("notebook cells must be strings or Cell objects")
    return Cell(
        source=source,
        mode=mode,
        name=name,
        display=display,
        raw=raw,
        attrs=_cell_attrs(
            attrs,
            id=id,
            pinned=pinned,
            output=output,
        ),
    )


def coerce_cell(source: CellInput, *, mode: AuthorMode) -> Cell:
    if isinstance(source, Cell):
        return source
    return _source_cell(source, mode=mode)


def ensure_author_mode(mode: str) -> None:
    if mode not in AUTHOR_MODES:
        raise ValueError(f"Unsupported Python-authored cell mode: {mode!r}")


def _cell_attrs(
    attrs: Mapping[str, Any] | None,
    *,
    id: int | None,
    pinned: bool,
    output: str | None,
) -> dict[str, Any]:
    out = {} if attrs is None else dict(attrs)
    if id is not None:
        out["id"] = id
    if pinned:
        out["pinned"] = True
    if output is not None:
        out["output"] = output
    return out
