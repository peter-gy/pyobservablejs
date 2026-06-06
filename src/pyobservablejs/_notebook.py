"""Python widget models for Observable notebooks and cells."""

from __future__ import annotations

import dataclasses
import pathlib
import textwrap
from collections.abc import Iterable, Mapping, Sequence
from html.parser import HTMLParser
from typing import Any, cast

import anywidget
import traitlets

from ._files import FileInput, normalize_files, prepare_source
from ._graph import CellInfo, NotebookGraph, graph_from_raw
from ._observable import fetch_observablehq_notebook
from ._serialize import AUTHOR_MODES, SCRIPT_TYPES, AuthorMode, Mode, serialize
from ._variables import deserialize_value, serialize_variables


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

_WIDGET_TRAIT = anywidget.WidgetTrait()
_WIDGET_TO_JSON = _WIDGET_TRAIT.metadata["to_json"]


def _widgets_to_json(value: object, widget: object) -> object:
    if not isinstance(value, list):
        return value
    return [_WIDGET_TO_JSON(item, widget) for item in value]


def _widgets_from_json(value: object, _widget: object) -> object:
    return value


class _ObservableWidget(anywidget.AnyWidget):
    """Shared anywidget base for the bundled frontend assets."""

    _static_dir = pathlib.Path(__file__).parent / "static"
    _esm = _static_dir / "widget.js"
    _css = _static_dir / "widget.css"
    _esm_chunk_request = traitlets.Dict(default_value={}).tag(sync=True)
    _esm_chunk_response = traitlets.Dict(default_value={}).tag(sync=True)

    @traitlets.observe("_esm_chunk_request")
    def _respond_to_esm_chunk_request(self, change: dict[str, Any]) -> None:
        request = change["new"]
        seq = request.get("seq") if isinstance(request, dict) else None
        chunk_path = request.get("path") if isinstance(request, dict) else None
        response: dict[str, Any] = {"seq": seq, "path": chunk_path}
        try:
            response["source"] = self._read_esm_chunk(chunk_path)
        except Exception as error:
            response["error"] = f"{type(error).__name__}: {error}"
        self.set_trait("_esm_chunk_response", response)

    def _read_esm_chunk(self, chunk_path: object) -> str:
        if not isinstance(chunk_path, str):
            raise TypeError("chunk path must be a string")
        path = pathlib.PurePosixPath(chunk_path)
        if (
            path.is_absolute()
            or len(path.parts) < 2
            or path.parts[0] != "chunks"
            or ".." in path.parts
            or path.suffix != ".js"
        ):
            raise ValueError(f"unsupported widget chunk path: {chunk_path}")
        root = self._static_dir.resolve()
        resolved = (root / pathlib.Path(*path.parts)).resolve()
        try:
            resolved.relative_to(root)
        except ValueError as error:
            raise ValueError(f"unsupported widget chunk path: {chunk_path}") from error
        return resolved.read_text(encoding="utf-8")


class NotebookCell(_ObservableWidget):
    """Child anywidget model for one Observable cell.

    The parent ``Notebook`` owns rendering and Observable runtime state.
    ``NotebookCell`` exposes browser-synchronized values and graph metadata for
    its matching cell.
    """

    role = traitlets.Unicode("cell").tag(sync=True)
    name = traitlets.Unicode("").tag(sync=True)
    _value_names = traitlets.List(traitlets.Unicode(), default_value=[]).tag(sync=True)
    _values = traitlets.Dict(default_value={}).tag(sync=True)

    def __init__(self, **kwargs: Any) -> None:
        self._notebook: Notebook | None = None
        self._notebook_index: int | None = None
        super().__init__(**kwargs)

    def _bind_notebook(self, notebook: Notebook, index: int) -> None:
        self._notebook = notebook
        self._notebook_index = index

    @property
    def info(self) -> CellInfo | None:
        """Notebook Kit metadata for this cell, once the browser renders."""

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
    def value_names(self) -> tuple[str, ...]:
        """Names of browser-synchronized values currently exposed by this cell."""

        return tuple(self._value_names)

    @property
    def values(self) -> dict[str, Any]:
        """Latest browser-synchronized values exposed by this cell."""

        return {name: deserialize_value(value) for name, value in self._values.items()}

    @property
    def wire_values(self) -> dict[str, Any]:
        """Raw browser wire values for advanced inspection."""

        return dict(self._values)

    @property
    def value(self) -> Any:
        """Return this cell's synchronized value.

        Uses the cell's Python name when that name is present in ``values``.
        Falls back to the only synchronized value. Raises ``KeyError`` when the
        cell has no values or exposes multiple unnamed values.
        """

        return self._value()

    def _value(self, name: str | None = None) -> Any:
        values = self.values
        if name is not None:
            return values[name]
        if self.name and self.name in values:
            return values[self.name]
        if len(values) == 1:
            return next(iter(values.values()))
        if not values:
            raise KeyError("Cell exposes no synchronized values")
        raise KeyError("Cell exposes multiple values. Use cell.values[name]")


class Notebook(_ObservableWidget):
    """anywidget model for an Observable Notebook Kit notebook.

    Python owns cell specs, attachments, and Python-backed OJS variables. The
    browser renderer creates the Observable runtime, renders outputs, and syncs
    values plus graph metadata back to this model.
    """

    role = traitlets.Unicode("notebook").tag(sync=True)
    source = traitlets.Unicode("").tag(sync=True)
    spec = traitlets.Dict().tag(sync=True)
    attachments = traitlets.Dict().tag(sync=True)
    base_url = traitlets.Unicode("").tag(sync=True)
    _variables = traitlets.Dict(default_value={}).tag(sync=True)
    _variable_update = traitlets.Dict(default_value={}).tag(sync=True)
    _graph = traitlets.Dict(default_value={}).tag(sync=True)
    _value_names = traitlets.List(traitlets.Unicode(), default_value=[]).tag(sync=True)
    _values = traitlets.Dict(default_value={}).tag(sync=True)
    options = traitlets.Dict().tag(sync=True)
    _cell_widgets = traitlets.List(
        anywidget.WidgetTrait(),
        default_value=[],
    ).tag(sync=True, to_json=_widgets_to_json, from_json=_widgets_from_json)

    @traitlets.validate("_cell_widgets")
    def _validate_cell_widgets(self, proposal: Any) -> list[NotebookCell]:
        widgets = proposal["value"]
        if not all(isinstance(item, NotebookCell) for item in widgets):
            raise traitlets.TraitError(
                "_cell_widgets must contain NotebookCell widgets"
            )
        return cast(list[NotebookCell], widgets)

    def __init__(
        self,
        *cells: CellInput,
        title: str = "Untitled",
        theme: str | Mapping[str, str] = "air",
        mode: AuthorMode = "ojs",
        attachments: Mapping[str, FileInput] | None = None,
        base_path: str | pathlib.Path | None = None,
        variables: Mapping[str, Any] | None = None,
        show_pinned_source: bool = False,
    ) -> None:
        """Create a notebook from Python-authored cells.

        Plain strings use ``mode``. Helper-created cells keep their own modes.
        ``attachments`` registers ``FileAttachment`` values, with ``base_path``
        resolving relative local paths. ``variables`` sets Python-owned OJS
        variables. ``show_pinned_source`` renders source for pinned cells.

        Raises:
            ValueError: ``mode`` or a variable name is invalid.
            TypeError: A cell or variable value is unsupported.
            FileNotFoundError: An explicit local attachment path does not exist.
            OSError: An explicit local attachment path cannot be read.
        """

        _ensure_author_mode(mode)
        cell_specs = [
            _coerce_cell(item, mode=mode).to_spec(i)
            for i, item in enumerate(cells, start=1)
        ]
        self._initialize(
            source="",
            spec={"title": title, "theme": theme, "cells": cell_specs},
            attachments=normalize_files(attachments, base_path=base_path),
            variables=variables,
            show_pinned_source=show_pinned_source,
            cell_widgets=_cell_widgets_for_specs(cell_specs),
        )

    @classmethod
    def _from_prepared(
        cls,
        *,
        source: str,
        spec: Mapping[str, Any],
        attachments: Mapping[str, Any],
        variables: Mapping[str, Any] | None,
        show_pinned_source: bool,
        cell_widgets: Sequence[NotebookCell],
    ) -> "Notebook":
        notebook = cls.__new__(cls)
        notebook._initialize(
            source=source,
            spec=spec,
            attachments=attachments,
            variables=variables,
            show_pinned_source=show_pinned_source,
            cell_widgets=cell_widgets,
        )
        return notebook

    def _initialize(
        self,
        *,
        source: str,
        spec: Mapping[str, Any],
        attachments: Mapping[str, Any],
        variables: Mapping[str, Any] | None,
        show_pinned_source: bool,
        cell_widgets: Sequence[NotebookCell],
    ) -> None:
        self._variable_values = _copy_variables(variables)
        self._variable_update_seq = 0
        super().__init__(
            source=source,
            spec=dict(spec),
            attachments=dict(attachments),
            _variables=serialize_variables(self._variable_values),
            options={"show_source": show_pinned_source},
            _cell_widgets=list(cell_widgets),
        )
        for index, cell_widget in enumerate(self._cell_widgets):
            if isinstance(cell_widget, NotebookCell):
                cell_widget._bind_notebook(self, index)

    @property
    def variables(self) -> dict[str, Any]:
        """Current Python-owned Observable variables."""

        return dict(self._variable_values)

    def update_variables(
        self,
        values: Mapping[str, Any] | Iterable[tuple[str, Any]] | None = None,
        /,
        **kwargs: Any,
    ) -> None:
        """Merge Python-owned variable updates into the live runtime.

        Accepts a mapping, key/value pairs, keyword arguments, or both. Nonempty
        updates set ``_variable_update`` with kind ``"set"`` and refresh the
        serialized ``_variables`` trait.
        """

        updates = _updates_from_args("update_variables", values, kwargs)
        if updates:
            self._patch_variables(updates)

    def replace_variables(
        self,
        values: Mapping[str, Any] | Iterable[tuple[str, Any]] | None = None,
        /,
        **kwargs: Any,
    ) -> None:
        """Replace the full Python-owned variable environment.

        Accepts a mapping, key/value pairs, keyword arguments, or both. Omitted
        names are released. The browser receives a replacement update and
        rebuilds the runtime so original notebook definitions return for
        released names.
        """

        self._replace_variables(
            _updates_from_args("replace_variables", values, kwargs),
            update_kind="replace",
        )

    def reset_variables(self, *names: str) -> None:
        """Release Python ownership for names that are currently overridden.

        Empty calls and missing names are no-ops. Removing at least one name
        sends a replacement update and restores original notebook definitions in
        the browser runtime.
        """

        if not names:
            return
        values = dict(self._variable_values)
        changed = False
        for name in names:
            if name in values:
                del values[name]
                changed = True
        if changed:
            self._replace_variables(values, update_kind="replace")

    def _patch_variables(self, updates: Mapping[str, Any]) -> None:
        serialized_updates = serialize_variables(updates)
        self._variable_values = _copy_variables({**self._variable_values, **updates})
        self._variable_update_seq += 1
        self.set_trait(
            "_variable_update",
            {
                "seq": self._variable_update_seq,
                "kind": "set",
                "values": serialized_updates,
            },
        )
        self.set_trait("_variables", serialize_variables(self._variable_values))

    def _replace_variables(
        self,
        value: Mapping[str, Any],
        *,
        update_kind: str = "replace",
    ) -> None:
        self._variable_values = _copy_variables(value)
        self._variable_update_seq += 1
        self.set_trait(
            "_variable_update",
            {
                "seq": self._variable_update_seq,
                "kind": update_kind,
                "values": serialize_variables(self._variable_values),
            },
        )
        self.set_trait("_variables", serialize_variables(self._variable_values))

    @property
    def graph(self) -> NotebookGraph | None:
        """Symbolic cell graph synced from the browser runtime."""

        return graph_from_raw(self._graph)

    @property
    def cells(self) -> tuple[NotebookCell, ...]:
        """Child cell widgets in notebook order."""

        return tuple(self._cell_widgets)

    def cell(self, key: int | str) -> NotebookCell:
        """Return a cell widget by index or Python name."""

        if isinstance(key, int):
            return self.cells[key]
        matches = [item for item in self.cells if item.name == key]
        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            raise KeyError(f"Ambiguous Observable cell name: {key!r}")
        raise KeyError(f"Unknown Observable cell name: {key!r}")

    def cell_for_variable(self, name: str) -> NotebookCell:
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
            raise KeyError(f"Ambiguous Observable variable: {name!r}")
        raise KeyError(f"Unknown Observable variable: {name!r}")

    @property
    def value_names(self) -> tuple[str, ...]:
        """Names of browser-synchronized values currently exposed by the notebook."""

        return tuple(self._value_names)

    @property
    def values(self) -> dict[str, Any]:
        """Latest browser-synchronized values for notebook cells."""

        if self._values:
            return {
                name: deserialize_value(value) for name, value in self._values.items()
            }
        return _unique_cell_values(self.cells)

    @property
    def wire_values(self) -> dict[str, Any]:
        """Raw browser wire values for advanced inspection."""

        if self._values:
            return dict(self._values)
        return _unique_cell_wire_values(self.cells)

    def value(self, name: str) -> Any:
        """Return the synchronized value for ``name``.

        Uses graph metadata to read the defining cell when available. Falls back
        to notebook-level synchronized values. Raises ``KeyError`` when no value
        has synchronized for ``name``.
        """

        graph = self.graph
        if graph is not None:
            try:
                cell = self.cell_for_variable(name)
            except KeyError:
                cell = None
            if cell is not None and name in cell.values:
                return cell.values[name]
        return self.values[name]

    @classmethod
    def from_html(
        cls,
        source: str,
        *,
        attachments: Mapping[str, FileInput] | None = None,
        base_path: str | pathlib.Path | None = None,
        portable: bool = True,
        variables: Mapping[str, Any] | None = None,
        show_pinned_source: bool = False,
    ) -> "Notebook":
        """Create a source-backed notebook from a Notebook Kit HTML string.

        With ``portable=True`` and ``base_path`` set, local file attachments are
        embedded and relative JavaScript imports are recursively rewritten to
        data URLs. With ``portable=False``, source references stay unchanged and
        resolve relative to the frontend page URL. Explicit ``attachments``
        override discovered attachments with the same name. ``variables`` sets
        Python-owned OJS variables for the rendered notebook.
        """

        return cls._from_html_source(
            source,
            attachments=attachments,
            base_path=base_path,
            portable=portable,
            variables=variables,
            show_pinned_source=show_pinned_source,
        )

    @classmethod
    def _from_html_source(
        cls,
        source: str,
        *,
        attachments: Mapping[str, FileInput] | None,
        base_path: str | pathlib.Path | None,
        portable: bool,
        variables: Mapping[str, Any] | None,
        show_pinned_source: bool,
    ) -> "Notebook":
        if not isinstance(source, str):
            raise TypeError("source must be a Notebook Kit HTML string")
        source, discovered = prepare_source(
            source,
            base_path=base_path,
            embed=portable,
            rewrite_imports=portable,
        )
        normalized = normalize_files(attachments, base_path=base_path)
        parsed = _parse_html_cells(source)
        return cls._from_prepared(
            variables=variables,
            show_pinned_source=show_pinned_source,
            source=source,
            spec={},
            attachments={**discovered, **normalized},
            cell_widgets=_cell_widgets_for_cells(parsed),
        )

    @classmethod
    def from_observablehq(
        cls,
        specifier: str,
        *,
        variables: Mapping[str, Any] | None = None,
        attachments: Mapping[str, FileInput] | None = None,
        show_pinned_source: bool = False,
        timeout: float | None = 30,
    ) -> "Notebook":
        """Fetch a public ObservableHQ notebook through the document API.

        ``specifier`` may be an ObservableHQ URL, slug, id, or document API URL.
        ObservableHQ API ``js`` cells are imported as OJS cells. Remote uploaded
        files become URL-backed attachments. ``timeout`` controls the network
        request. Invalid specifiers or non-JSON responses raise ``ValueError``.
        HTTP and network failures raise ``OSError``.
        """

        source, discovered = fetch_observablehq_notebook(specifier, timeout=timeout)
        normalized = normalize_files(attachments, base_path=None)
        return cls._from_html_source(
            source,
            base_path=None,
            portable=False,
            variables=variables,
            attachments={**discovered, **normalized},
            show_pinned_source=show_pinned_source,
        )

    def to_notebook_html(self) -> str:
        """Return Notebook Kit HTML for saving or inspecting the notebook."""

        if self.source:
            return self.source
        return serialize(self.spec)


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


def _coerce_cell(source: CellInput, *, mode: AuthorMode) -> Cell:
    if isinstance(source, Cell):
        return source
    return _source_cell(source, mode=mode)


def _ensure_author_mode(mode: str) -> None:
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


def _updates_from_args(
    name: str,
    values: Mapping[str, Any] | Iterable[tuple[str, Any]] | None,
    kwargs: Mapping[str, Any],
) -> dict[str, Any]:
    updates: dict[str, Any] = {}
    if values is not None:
        if isinstance(values, Mapping):
            updates.update(values)
        else:
            try:
                updates.update(dict(values))
            except (TypeError, ValueError) as exc:
                raise TypeError(f"{name} expects a mapping or key/value pairs") from exc
    updates.update(kwargs)
    return updates


def _copy_variables(variables: Mapping[str, Any] | None) -> dict[str, Any]:
    serialize_variables(variables)
    return {} if variables is None else dict(variables)


def _unique_cell_values(cells: Sequence[NotebookCell]) -> dict[str, Any]:
    counts: dict[str, int] = {}
    values: dict[str, Any] = {}
    for item in cells:
        for name, value in item.values.items():
            counts[name] = counts.get(name, 0) + 1
            values[name] = value
    return {name: value for name, value in values.items() if counts[name] == 1}


def _unique_cell_wire_values(cells: Sequence[NotebookCell]) -> dict[str, Any]:
    counts: dict[str, int] = {}
    values: dict[str, Any] = {}
    for item in cells:
        for name, value in item.wire_values.items():
            counts[name] = counts.get(name, 0) + 1
            values[name] = value
    return {name: value for name, value in values.items() if counts[name] == 1}


def _cell_widgets_for_specs(specs: Sequence[Mapping[str, Any]]) -> list[NotebookCell]:
    return [NotebookCell(name=str(item.get("name") or "")) for item in specs]


def _cell_widgets_for_cells(cells: Sequence[Cell]) -> list[NotebookCell]:
    return [NotebookCell(name=item.name or "") for item in cells]


_MODE_BY_SCRIPT_TYPE = {
    script_type.lower(): mode for mode, script_type in SCRIPT_TYPES.items()
}


class _NotebookHTMLParser(HTMLParser):
    """Collect script cells from Notebook Kit HTML."""

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
