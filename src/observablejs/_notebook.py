"""Python objects that become Observable notebooks in the browser.

The public API builds Notebook Kit-compatible cell specs, stores them on an
anywidget model, and lets the TypeScript widget render those specs with the
Observable runtime. Python data travels separately on the ``_data`` trait so it
can be revived as Observable builtins before any cells run.
"""

from __future__ import annotations

import dataclasses
import pathlib
import textwrap
from collections.abc import Mapping
from html.parser import HTMLParser
from typing import Any, cast

import anywidget
import traitlets

from ._files import FileInput, normalize_files, prepare_source
from ._graph import CellInfo, NotebookGraph, graph_from_raw
from ._serialize import SCRIPT_TYPES, Mode, serialize
from ._variables import serialize_variables


@dataclasses.dataclass(frozen=True)
class Cell:
    """A Python-authored Notebook Kit script cell.

    ``mode`` selects the script type that Notebook Kit expects. ``name`` is also
    used for the child cell widget so Python can later address
    ``notebook.cell("name")`` and read the values synchronized from OJS.
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
        """Convert the Python cell object to Notebook Kit's JSON cell shape."""

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


_WIDGET_TRAIT = anywidget.WidgetTrait()
_WIDGET_TO_JSON = _WIDGET_TRAIT.metadata["to_json"]


def _widgets_to_json(value: object, widget: object) -> object:
    if not isinstance(value, list):
        return value
    return [_WIDGET_TO_JSON(item, widget) for item in value]


def _widgets_from_json(value: object, _widget: object) -> object:
    return value


class _ObservableWidget(anywidget.AnyWidget):
    """Shared anywidget base that points Python models at the bundled frontend."""

    _esm = pathlib.Path(__file__).parent / "static" / "widget.js"
    _css = pathlib.Path(__file__).parent / "static" / "widget.css"


class CellHandle(_ObservableWidget):
    """Child anywidget model that mirrors one Observable cell.

    Notebook widgets compose these child widgets in the browser. Each child
    receives values exposed by its matching OJS cell through ``variables``.
    Symbolic metadata comes from the owning notebook's graph.
    """

    role = traitlets.Unicode("cell").tag(sync=True)
    name = traitlets.Unicode("").tag(sync=True)
    variable_names = traitlets.List(traitlets.Unicode(), default_value=[]).tag(
        sync=True
    )
    variables = traitlets.Dict(default_value={}).tag(sync=True)

    def __init__(self, **kwargs: Any) -> None:
        self._notebook: Notebook | None = None
        self._notebook_index: int | None = None
        super().__init__(**kwargs)

    def _bind_notebook(self, notebook: Notebook, index: int) -> None:
        self._notebook = notebook
        self._notebook_index = index

    @property
    def info(self) -> CellInfo | None:
        if self._notebook is None or self._notebook_index is None:
            return None
        graph = self._notebook.graph
        return None if graph is None else graph.cell(self._notebook_index)

    @property
    def defines(self) -> tuple[str, ...]:
        info = self.info
        return () if info is None else info.defines

    @property
    def references(self) -> tuple[str, ...]:
        info = self.info
        return () if info is None else info.references

    @property
    def inputs(self) -> tuple[str, ...]:
        return self.references

    @property
    def outputs(self) -> tuple[str, ...]:
        info = self.info
        return () if info is None else info.outputs

    @property
    def runtime_outputs(self) -> tuple[str, ...]:
        info = self.info
        return () if info is None else info.runtime_outputs

    @property
    def output(self) -> str | None:
        info = self.info
        return None if info is None else info.output

    @property
    def values(self) -> dict[str, Any]:
        return dict(self.variables)

    @property
    def value(self) -> Any:
        values = self.values
        if self.name and self.name in values:
            return values[self.name]
        if len(values) == 1:
            return next(iter(values.values()))
        return values


class Notebook(_ObservableWidget):
    """anywidget model that renders an Observable Notebook Kit notebook.

    A notebook can be created from Python cells (stored as ``spec``) or from
    existing Notebook Kit HTML (stored as ``source``). In both cases ``data`` is
    serialized to the synced ``_data`` trait; the frontend revives it into normal
    Observable variables before defining the cells.
    """

    role = traitlets.Unicode("notebook").tag(sync=True)
    source = traitlets.Unicode("").tag(sync=True)
    spec = traitlets.Dict().tag(sync=True)
    attachments = traitlets.Dict().tag(sync=True)
    base_url = traitlets.Unicode("").tag(sync=True)
    _data = traitlets.Dict(default_value={}).tag(sync=True)
    _graph = traitlets.Dict(default_value={}).tag(sync=True)
    options = traitlets.Dict().tag(sync=True)
    _cell_widgets = traitlets.List(
        anywidget.WidgetTrait(),
        default_value=[],
    ).tag(sync=True, to_json=_widgets_to_json, from_json=_widgets_from_json)

    def __init__(
        self,
        *cells: CellInput,
        title: str = "Untitled",
        theme: str | Mapping[str, str] = "air",
        mode: Mode = "ojs",
        attachments: Mapping[str, FileInput] | None = None,
        base_path: str | pathlib.Path | None = None,
        data: Mapping[str, Any] | None = None,
        show_pinned_source: bool = False,
        **kwargs: Any,
    ) -> None:
        """Create a notebook from Python-authored cells.

        ``data`` remains available in Python as the original mapping while the
        synced ``_data`` trait holds the JSON-compatible wire form consumed by
        TypeScript.
        """

        self._data_values = _copy_data(data)
        cell_specs = [
            cell(item, mode=mode).to_spec(i) for i, item in enumerate(cells, start=1)
        ]
        spec = {
            "title": title,
            "theme": theme,
            "cells": cell_specs,
        }
        cell_widgets = list(
            kwargs.get("_cell_widgets", _cell_widgets_for_specs(cell_specs))
        )
        kwargs.setdefault("spec", spec)
        kwargs.setdefault(
            "attachments",
            normalize_files(attachments, base_path=base_path),
        )
        kwargs.setdefault("_data", serialize_variables(self._data_values))
        kwargs.setdefault("options", {"show_source": show_pinned_source})
        kwargs.setdefault("_cell_widgets", cell_widgets)
        super().__init__(**kwargs)
        for index, cell_widget in enumerate(self._cell_widgets):
            if isinstance(cell_widget, CellHandle):
                cell_widget._bind_notebook(self, index)

    @property
    def data(self) -> dict[str, Any]:
        """Python values currently exposed to the Observable runtime."""

        return dict(self._data_values)

    @data.setter
    def data(self, value: Mapping[str, Any]) -> None:
        self._data_values = _copy_data(value)
        self.set_trait("_data", serialize_variables(self._data_values))

    @property
    def graph(self) -> NotebookGraph | None:
        """Latest browser-produced symbolic graph for the notebook."""

        return graph_from_raw(self._graph)

    @property
    def cells(self) -> tuple[CellHandle, ...]:
        """Cell handles synchronized with the corresponding OJS cells."""

        return tuple(self._cell_widgets)

    def cell(self, key: int | str) -> CellHandle:
        """Return a cell by index, handle name, or unique defined variable."""

        if isinstance(key, int):
            return self.cells[key]
        cells = self.cells
        handle_matches = [
            (index, item) for index, item in enumerate(cells) if item.name == key
        ]
        if len(handle_matches) > 1:
            raise KeyError(f"Ambiguous Observable cell handle: {key!r}")
        graph = self.graph
        output_matches = (
            []
            if graph is None
            else [cell.index for cell in graph.cells if key in cell.defines]
        )
        if handle_matches:
            index, item = handle_matches[0]
            if any(output_index != index for output_index in output_matches):
                raise KeyError(f"Ambiguous Observable cell key: {key!r}")
            return item
        return self.defining_cell(key)

    def defining_cell(self, name: str) -> CellHandle:
        """Return the unique cell that defines an Observable variable."""

        graph = self.graph
        cells = self.cells
        matches = (
            []
            if graph is None
            else [cell.index for cell in graph.cells if name in cell.defines]
        )
        if len(matches) == 1:
            index = matches[0]
            if 0 <= index < len(cells):
                return cells[index]
        if len(matches) > 1:
            raise KeyError(f"Ambiguous Observable cell output: {name!r}")
        raise KeyError(f"Unknown Observable cell output: {name!r}")

    @property
    def values(self) -> dict[str, Any]:
        """Latest browser-synchronized values for all named notebook cells."""

        merged: dict[str, Any] = {}
        for item in self.cells:
            merged.update(item.values)
        return merged

    def value(self, name: str) -> Any:
        """Return the latest browser-synchronized value for ``name``."""

        return self.values[name]

    @classmethod
    def from_html(
        cls,
        source: str,
        *,
        attachments: Mapping[str, FileInput] | None = None,
        base_path: str | pathlib.Path | None = None,
        portable: bool = True,
        data: Mapping[str, Any] | None = None,
        show_pinned_source: bool = False,
        **kwargs: Any,
    ) -> "Notebook":
        """Create a notebook from Notebook Kit HTML.

        Local ``FileAttachment`` calls and relative imports can be embedded for
        portability, while Python ``data`` still enters the OJS runtime through
        the same ``_data`` trait used by Python-authored notebooks.
        """

        source, discovered = prepare_source(
            source,
            base_path=base_path,
            embed=portable,
            rewrite_imports=portable,
        )
        normalized = normalize_files(attachments, base_path=base_path)
        kwargs.setdefault("source", source)
        kwargs.setdefault("attachments", {**discovered, **normalized})
        kwargs.setdefault("options", {"show_source": show_pinned_source})
        parsed = _parse_html_cells(source)
        kwargs.setdefault("spec", {})
        kwargs.setdefault("_cell_widgets", _cell_widgets_for_cells(parsed))
        return cls(data=data, **kwargs)

    @classmethod
    def from_file(
        cls,
        path: str | pathlib.Path,
        *,
        portable: bool = True,
        data: Mapping[str, Any] | None = None,
        attachments: Mapping[str, FileInput] | None = None,
        show_pinned_source: bool = False,
        **kwargs: Any,
    ) -> "Notebook":
        """Load Notebook Kit HTML from disk and create a notebook widget."""

        path = pathlib.Path(path).expanduser().resolve()
        return cls.from_html(
            path.read_text(encoding="utf-8"),
            base_path=path.parent,
            portable=portable,
            data=data,
            attachments=attachments,
            show_pinned_source=show_pinned_source,
            **kwargs,
        )

    def to_notebook_html(self) -> str:
        """Return Notebook Kit HTML for saving or inspecting the notebook."""

        if self.source:
            return self.source
        return serialize(self.spec)


def cell(
    source: CellInput,
    *,
    name: str | None = None,
    display: bool = True,
    mode: Mode = "ojs",
    raw: bool = False,
    attrs: Mapping[str, Any] | None = None,
) -> Cell:
    """Create an Observable JavaScript cell.

    Plain strings default to Observable JavaScript because that is the notebook
    language users normally expect inside ``ojs.Notebook``.
    """

    if isinstance(source, Cell):
        if any([name is not None, display is not True, mode != "ojs", raw, attrs]):
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
        attrs={} if attrs is None else attrs,
    )


def module(source: str, **kwargs: Any) -> Cell:
    """Create a standard JavaScript module cell."""

    return cell(source, mode="js", **kwargs)


def md(source: str, **kwargs: Any) -> Cell:
    """Create a Markdown cell."""

    return cell(source, mode="md", **kwargs)


def html(source: str, **kwargs: Any) -> Cell:
    """Create an HTML cell."""

    return cell(source, mode="html", **kwargs)


def sql(source: str, **kwargs: Any) -> Cell:
    """Create a SQL cell."""

    return cell(source, mode="sql", **kwargs)


def _copy_data(data: Mapping[str, Any] | None) -> dict[str, Any]:
    # Validate now, but keep Python-facing values unmodified. The serialized
    # representation lives only on the synced `_data` trait.
    serialize_variables(data)
    return {} if data is None else dict(data)


def _cell_widgets_for_specs(specs: list[dict[str, Any]]) -> list[CellHandle]:
    # One child widget per cell gives Python stable handles for reading cell
    # values and lets anywidget composition render those handles independently.
    return [CellHandle(name=str(item.get("name") or "")) for item in specs]


def _cell_widgets_for_cells(cells: list[Cell]) -> list[CellHandle]:
    return [CellHandle(name=item.name or "") for item in cells]


_MODE_BY_SCRIPT_TYPE = {
    script_type.lower(): mode for mode, script_type in SCRIPT_TYPES.items()
}


class _NotebookHTMLParser(HTMLParser):
    """Extract Notebook Kit script cells from source-backed HTML."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.cells: list[Cell] = []
        self._inside_notebook = False
        self._script_attrs: dict[str, str | None] | None = None
        self._script_parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if tag == "notebook":
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


def _parse_html_cells(source: str) -> list[Cell]:
    parser = _NotebookHTMLParser()
    parser.feed(source)
    return parser.cells


def _optional_int(value: str | None) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except ValueError:
        return None
