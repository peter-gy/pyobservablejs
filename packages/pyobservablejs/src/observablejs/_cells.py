"""Authored Observable cell helpers."""

from __future__ import annotations

import dataclasses
import textwrap
from typing import Any, NotRequired, TypedDict, cast

from ._cell_ids import _MAX_SAFE_CELL_ID, _is_safe_cell_id
from ._serialize import SCRIPT_TYPES, Mode
from .types import NotebookKitCellMetadata


class NotebookCellSpec(TypedDict):
    id: int
    value: str
    mode: Mode
    key: NotRequired[str]
    pinned: NotRequired[bool]
    hidden: NotRequired[bool]
    output: NotRequired[str]
    format: NotRequired[str]
    database: NotRequired[str]
    since: NotRequired[str | int | float]


@dataclasses.dataclass(frozen=True)
class Cell:
    """Notebook Kit cell authored from Python source.

    Source strings are dedented and stripped of leading or trailing newlines
    unless ``raw=True``.
    """

    source: str
    mode: Mode = "ojs"
    key: str | None = None
    display: bool = True
    raw: bool = False
    id: int | None = None
    pinned: bool = False
    output: str | None = None
    notebookkit_attrs: NotebookKitCellMetadata = dataclasses.field(
        default_factory=lambda: cast(NotebookKitCellMetadata, {})
    )

    def __post_init__(self) -> None:
        if not isinstance(self.source, str):
            raise TypeError("cell source must be a string")
        if self.mode not in SCRIPT_TYPES:
            raise ValueError(f"Unsupported Observable cell mode: {self.mode!r}")
        if self.key is not None and (not isinstance(self.key, str) or not self.key):
            raise ValueError("cell key must be a non-empty string or None")
        if self.id is not None and (
            not isinstance(self.id, int) or isinstance(self.id, bool)
        ):
            raise TypeError("cell id must be an integer or None")
        if self.id is not None and not _is_safe_cell_id(self.id):
            raise ValueError(f"cell id must be between 1 and {_MAX_SAFE_CELL_ID}")
        attrs = dict(self.notebookkit_attrs)
        collisions = {
            "hidden",
            "id",
            "key",
            "mode",
            "name",
            "output",
            "pinned",
            "value",
        } & set(attrs)
        if collisions:
            names = ", ".join(sorted(collisions))
            raise ValueError(f"notebookkit_attrs contains reserved fields: {names}")
        object.__setattr__(self, "notebookkit_attrs", attrs)
        if self.raw:
            return
        source = textwrap.dedent(self.source).strip("\n")
        object.__setattr__(self, "source", source)

    def _to_spec(self, generated_id: int) -> NotebookCellSpec:
        spec: dict[str, Any] = {
            "id": self.id if self.id is not None else generated_id,
            "value": self.source,
            "mode": self.mode,
        }
        if self.key is not None:
            spec["key"] = self.key
        if not self.display:
            spec["hidden"] = True
        if self.pinned:
            spec["pinned"] = True
        if self.output is not None:
            spec["output"] = self.output
        for key, value in self.notebookkit_attrs.items():
            if value is not None:
                spec[key] = value
        return cast(NotebookCellSpec, spec)


NotebookCellInput = Cell


def ojs(
    source: str,
    *,
    key: str | None = None,
    display: bool = True,
    raw: bool = False,
    id: int | None = None,
    pinned: bool = False,
    output: str | None = None,
    notebookkit_attrs: NotebookKitCellMetadata | None = None,
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
    source: str,
    *,
    key: str | None = None,
    display: bool = True,
    raw: bool = False,
    id: int | None = None,
    pinned: bool = False,
    output: str | None = None,
    notebookkit_attrs: NotebookKitCellMetadata | None = None,
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
    source: str,
    *,
    key: str | None = None,
    display: bool = True,
    raw: bool = False,
    id: int | None = None,
    pinned: bool = False,
    output: str | None = None,
    notebookkit_attrs: NotebookKitCellMetadata | None = None,
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
    source: str,
    *,
    key: str | None = None,
    display: bool = True,
    raw: bool = False,
    id: int | None = None,
    pinned: bool = False,
    output: str | None = None,
    notebookkit_attrs: NotebookKitCellMetadata | None = None,
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
    source: str,
    *,
    mode: Mode,
    key: str | None = None,
    display: bool = True,
    raw: bool = False,
    id: int | None = None,
    pinned: bool = False,
    output: str | None = None,
    notebookkit_attrs: NotebookKitCellMetadata | None = None,
) -> Cell:
    if not isinstance(source, str):
        raise TypeError("cell source must be a string")
    return Cell(
        source=source,
        mode=mode,
        key=key,
        display=display,
        raw=raw,
        id=id,
        pinned=pinned,
        output=output,
        notebookkit_attrs={} if notebookkit_attrs is None else notebookkit_attrs,
    )


def coerce_cell(source: NotebookCellInput) -> Cell:
    if isinstance(source, Cell):
        return source
    raise TypeError(
        "notebook cells must be created with obs.ojs, obs.js, obs.md, or obs.html"
    )
