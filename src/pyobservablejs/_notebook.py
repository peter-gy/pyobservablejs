"""Python widget models for Observable notebooks and cells."""

from __future__ import annotations

import pathlib
from collections.abc import Iterable, Mapping, Sequence
from typing import Any, cast

import anywidget
import traitlets

from ._cells import Cell, CellInput, coerce_cell, ensure_author_mode
from ._chunked_anywidget import ChunkedAnyWidget, ChunkedAnyWidgetFrontend
from ._html import parse_html_cells, parse_html_theme
from ._files import FileInput, normalize_files, prepare_source
from ._graph import CellInfo, NotebookGraph, graph_from_raw
from ._observable import fetch_observablehq_notebook
from ._serialize import AuthorMode, serialize
from ._themes import Theme, normalize_theme
from ._variables import deserialize_value, serialize_variables


_WIDGET_TRAIT = anywidget.WidgetTrait()
_WIDGET_TO_JSON = _WIDGET_TRAIT.metadata["to_json"]
_OBSERVABLE_WIDGET_STATIC_DIR = pathlib.Path(__file__).parent / "static"
_OBSERVABLE_WIDGET_DEV_SERVER_ENV = "PYOBSERVABLEJS_VITE_DEV_SERVER"
_OBSERVABLE_WIDGET_DEV_MODULE = "js/widget/dev.ts?anywidget"
_OBSERVABLE_WIDGET_FRONTEND = ChunkedAnyWidgetFrontend(
    static_dir=_OBSERVABLE_WIDGET_STATIC_DIR,
    dev_server_env=_OBSERVABLE_WIDGET_DEV_SERVER_ENV,
    dev_module=_OBSERVABLE_WIDGET_DEV_MODULE,
)


def _widgets_to_json(value: object, widget: object) -> object:
    if not isinstance(value, list):
        return value
    return [_WIDGET_TO_JSON(item, widget) for item in value]


def _widgets_from_json(value: object, _widget: object) -> object:
    return value


class _ObservableWidget(ChunkedAnyWidget):
    """Shared anywidget base for the bundled frontend assets."""

    _frontend = _OBSERVABLE_WIDGET_FRONTEND
    _esm, _css = _OBSERVABLE_WIDGET_FRONTEND.anywidget_assets()


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
    theme = traitlets.Any(default_value="air").tag(sync=True)
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

    @traitlets.validate("theme")
    def _validate_theme(self, proposal: Any) -> Theme:
        return normalize_theme(proposal["value"])

    @traitlets.observe("theme")
    def _sync_theme_to_spec(self, change: Any) -> None:
        if getattr(self, "_initializing_notebook", False) or self.source:
            return
        spec = dict(self.spec)
        spec["theme"] = change["new"]
        self.set_trait("spec", spec)

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

        ensure_author_mode(mode)
        normalized_theme = normalize_theme(theme)
        cell_specs = [
            coerce_cell(item, mode=mode).to_spec(i)
            for i, item in enumerate(cells, start=1)
        ]
        self._initialize(
            source="",
            spec={"title": title, "theme": normalized_theme, "cells": cell_specs},
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
        normalized_theme = _notebook_theme(source, spec)
        spec_dict = dict(spec)
        if not source:
            spec_dict["theme"] = normalized_theme
        self._initializing_notebook = True
        try:
            super().__init__(
                source=source,
                spec=spec_dict,
                theme=normalized_theme,
                attachments=dict(attachments),
                _variables=serialize_variables(self._variable_values),
                options={"show_source": show_pinned_source},
                _cell_widgets=list(cell_widgets),
            )
        finally:
            self._initializing_notebook = False
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
        parsed = parse_html_cells(source)
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


def _notebook_theme(source: str, spec: Mapping[str, Any]) -> Theme:
    if "theme" in spec:
        return normalize_theme(spec["theme"])
    if source:
        return parse_html_theme(source)
    return "air"
