"""Authored Observable cell helpers."""

from __future__ import annotations

import dataclasses
import textwrap
from collections.abc import Mapping
from typing import Any, NotRequired, TypedDict, cast

from ._serialize import SCRIPT_TYPES, Mode


class NotebookCellSpec(TypedDict):
    id: int
    value: str
    mode: Mode
    name: NotRequired[str]
    pinned: NotRequired[bool]
    hidden: NotRequired[bool]
    output: NotRequired[str]
    format: NotRequired[str]
    database: NotRequired[str]


@dataclasses.dataclass(frozen=True)
class Cell:
    """Notebook Kit cell authored from Python source.

    Source strings are dedented and stripped of leading or trailing newlines
    unless ``raw=True``. ``to_spec`` returns the JSON shape consumed by Notebook
    Kit and by the bundled anywidget renderer.
    """

    source: str
    mode: Mode = "ojs"
    key: str | None = None
    name: str | None = None
    display: bool = True
    raw: bool = False
    notebookkit_attrs: Mapping[str, Any] = dataclasses.field(default_factory=dict)

    def __post_init__(self) -> None:
        if not isinstance(self.source, str):
            raise TypeError("cell source must be a string")
        if self.raw:
            return
        source = textwrap.dedent(self.source).strip("\n")
        object.__setattr__(self, "source", source)

    def to_spec(self, id: int) -> NotebookCellSpec:
        """Return this cell in Notebook Kit's JSON cell shape."""

        if self.mode not in SCRIPT_TYPES:
            raise ValueError(f"Unsupported Observable cell mode: {self.mode!r}")
        attrs = dict(self.notebookkit_attrs)
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
        return cast(NotebookCellSpec, spec)


CellInput = str | Cell
NotebookCellInput = Cell


def ojs(
    source: CellInput,
    *,
    key: str | None = None,
    display: bool = True,
    raw: bool = False,
    id: int | None = None,
    pinned: bool = False,
    output: str | None = None,
    notebookkit_attrs: Mapping[str, Any] | None = None,
) -> Cell:
    """Return an Observable JavaScript source cell."""

    return _source_cell(
        source,
        mode="ojs",
        key=key,
        display=display,
        raw=raw,
        id=id,
        pinned=pinned,
        output=output,
        notebookkit_attrs=notebookkit_attrs,
    )


def js(
    source: CellInput,
    *,
    key: str | None = None,
    display: bool = True,
    raw: bool = False,
    id: int | None = None,
    pinned: bool = False,
    output: str | None = None,
    notebookkit_attrs: Mapping[str, Any] | None = None,
) -> Cell:
    """Return a standard JavaScript module source cell."""

    return _source_cell(
        source,
        mode="js",
        key=key,
        display=display,
        raw=raw,
        id=id,
        pinned=pinned,
        output=output,
        notebookkit_attrs=notebookkit_attrs,
    )


def md(
    source: CellInput,
    *,
    key: str | None = None,
    display: bool = True,
    raw: bool = False,
    id: int | None = None,
    pinned: bool = False,
    output: str | None = None,
    notebookkit_attrs: Mapping[str, Any] | None = None,
) -> Cell:
    """Return a Markdown source cell."""

    return _source_cell(
        source,
        mode="md",
        key=key,
        display=display,
        raw=raw,
        id=id,
        pinned=pinned,
        output=output,
        notebookkit_attrs=notebookkit_attrs,
    )


def html(
    source: CellInput,
    *,
    key: str | None = None,
    display: bool = True,
    raw: bool = False,
    id: int | None = None,
    pinned: bool = False,
    output: str | None = None,
    notebookkit_attrs: Mapping[str, Any] | None = None,
) -> Cell:
    """Return an HTML source cell."""

    return _source_cell(
        source,
        mode="html",
        key=key,
        display=display,
        raw=raw,
        id=id,
        pinned=pinned,
        output=output,
        notebookkit_attrs=notebookkit_attrs,
    )


def _source_cell(
    source: CellInput,
    *,
    mode: Mode,
    key: str | None = None,
    display: bool = True,
    raw: bool = False,
    id: int | None = None,
    pinned: bool = False,
    output: str | None = None,
    notebookkit_attrs: Mapping[str, Any] | None = None,
) -> Cell:
    if isinstance(source, Cell):
        if any(
            [
                key is not None,
                display is not True,
                mode != source.mode,
                raw,
                id is not None,
                pinned,
                output is not None,
                notebookkit_attrs,
            ]
        ):
            raise TypeError("Cannot override an existing Cell")
        return source
    if not isinstance(source, str):
        raise TypeError("notebook cells must be strings or Cell objects")
    return Cell(
        source=source,
        mode=mode,
        key=key,
        display=display,
        raw=raw,
        notebookkit_attrs=_cell_attrs(
            notebookkit_attrs,
            id=id,
            pinned=pinned,
            output=output,
        ),
    )


def coerce_cell(source: NotebookCellInput) -> Cell:
    if isinstance(source, Cell):
        return source
    raise TypeError(
        "notebook cells must be created with obs.ojs, obs.js, obs.md, or obs.html"
    )


def _cell_attrs(
    notebookkit_attrs: Mapping[str, Any] | None,
    *,
    id: int | None,
    pinned: bool,
    output: str | None,
) -> dict[str, Any]:
    out = {} if notebookkit_attrs is None else dict(notebookkit_attrs)
    collisions = {"hidden", "id", "mode", "output", "pinned", "value"} & set(out)
    if collisions:
        names = ", ".join(sorted(collisions))
        raise ValueError(
            f"notebookkit_attrs cannot override first-class cell options: {names}"
        )
    if id is not None:
        out["id"] = id
    if pinned:
        out["pinned"] = True
    if output is not None:
        out["output"] = output
    return out
