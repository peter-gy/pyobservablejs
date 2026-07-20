"""Python notebook sessions, cell handles, and renderable views."""

from __future__ import annotations

import dataclasses
import pathlib
import weakref
from collections.abc import Iterable, Mapping, Sequence
from typing import Any, cast

import anywidget
import traitlets
from anywidget_bundle import Bundle, BundledWidget

from ._cells import NotebookCellInput
from ._files import FileAttachment, FileInput
from ._graph import NotebookGraph, graph_from_raw
from ._model import (
    NotebookModel,
    notebook_model_from_cells,
    notebook_model_from_html,
    notebook_model_from_observablehq,
    notebook_model_from_observablehq_document,
)
from ._observable import ObservableDocument
from ._serialize import serialize
from ._themes import Theme, normalize_theme
from ._variables import (
    OBSERVABLE_RESERVED_VARIABLE_NAMES,
    deserialize_value,
    prepare_variables,
    same_wire_value,
    validate_variable_name,
    variable_updates_from_args,
)

_WIDGET_TRAIT = anywidget.WidgetTrait()
_WIDGET_TO_JSON = _WIDGET_TRAIT.metadata["to_json"]
_WIDGET_FROM_JSON = _WIDGET_TRAIT.metadata["from_json"]
_OBSERVABLE_WIDGET_STATIC_DIR = pathlib.Path(__file__).parent / "static"
_OBSERVABLE_WIDGET_DEV_SERVER_ENV = "OBSERVABLEJS_VITE_DEV_SERVER"
_OBSERVABLE_WIDGET_BUNDLE = Bundle(
    static_dir=_OBSERVABLE_WIDGET_STATIC_DIR,
    dev_server_env=_OBSERVABLE_WIDGET_DEV_SERVER_ENV,
)
_MISSING_VARIABLE = object()


def _require_sequence_container(value: object, *, message: str) -> None:
    if isinstance(value, str | bytes | bytearray) or not isinstance(value, Sequence):
        raise TypeError(message)


class NotRenderedError(RuntimeError):
    """Raised when browser-synchronized view state is read before render."""


@dataclasses.dataclass(frozen=True)
class CellValues:
    """Browser-synchronized values for one rendered cell."""

    index: int
    key: str | None
    values: dict[str, Any]


class _ObservableWidget(BundledWidget):
    """Shared anywidget base for the bundled frontend assets."""

    bundle = _OBSERVABLE_WIDGET_BUNDLE


class NotebookCell:
    """Stable selection handle for one notebook cell."""

    __slots__ = ("_owner", "_index")
    _owner: Notebook
    _index: int

    def __init__(self) -> None:
        raise TypeError("NotebookCell objects are created with Notebook.cell()")

    @classmethod
    def _create(cls, notebook: Notebook, index: int) -> NotebookCell:
        cell = object.__new__(cls)
        cell._owner = notebook
        cell._index = index
        return cell

    @property
    def index(self) -> int:
        """Zero-based position in the notebook definition."""

        return self._index

    @property
    def key(self) -> str | None:
        """Python selection key assigned to this cell."""

        return self._owner._session._cell_keys[self._index] or None

    @property
    def name(self) -> str | None:
        """Notebook Kit name assigned to this cell."""

        return self._owner._session._cell_names[self._index] or None

    def view(self) -> NotebookView:
        """Create a display model for this cell and its dependencies."""

        return self._owner.view([self])


class _NotebookSession(anywidget.AnyWidget):
    """Private anywidget model for notebook definitions and shared state."""

    # AnyWidget applies later comm updates after this module has loaded.
    _esm = "export default { initialize() {} };"
    _model_role = traitlets.Unicode("session").tag(sync=True)
    _runtime_profile = traitlets.Enum(
        values=["notebook-kit", "observable"],
        default_value="notebook-kit",
    ).tag(sync=True)
    _source = traitlets.Unicode("").tag(sync=True)
    _spec = traitlets.Dict().tag(sync=True)
    theme = traitlets.Any(default_value="air").tag(sync=True)
    _attachments = traitlets.Dict().tag(sync=True)
    _base_url = traitlets.Unicode("").tag(sync=True)
    _variables = traitlets.Dict(default_value={}).tag(sync=True)
    _variable_update = traitlets.Dict(default_value={}).tag(sync=True)
    _view_values = traitlets.Dict(default_value={}).tag(sync=True)
    _options = traitlets.Dict().tag(sync=True)
    _cell_keys = traitlets.List(traitlets.Unicode(), default_value=[]).tag(sync=True)

    def __init__(
        self,
        model: NotebookModel,
        *,
        variables: Mapping[str, Any] | None,
        show_pinned_source: bool,
    ) -> None:
        self._reserved_variable_names = (
            OBSERVABLE_RESERVED_VARIABLE_NAMES
            if model.runtime_profile == "observable"
            else frozenset()
        )
        self._variable_values, variable_wire = self._prepare_variables(variables)
        self._cell_names = tuple(model.cell_names)
        self._views: weakref.WeakSet[NotebookView] = weakref.WeakSet()
        self._notebook_closed = False
        self._variable_update_seq = 0
        spec = dict(model.spec)
        if not model.source:
            spec["theme"] = model.theme
        self._initializing_notebook = True
        try:
            super().__init__(
                _runtime_profile=model.runtime_profile,
                _source=model.source,
                _spec=spec,
                theme=model.theme,
                _attachments=dict(model.attachments),
                _variables=variable_wire,
                _options={"show_source": show_pinned_source},
                _cell_keys=list(model.cell_keys),
            )
        finally:
            self._initializing_notebook = False

    @traitlets.validate("theme")
    def _validate_theme(self, proposal: Any) -> Theme:
        self._require_open()
        theme = normalize_theme(proposal["value"])
        if (
            not getattr(self, "_initializing_notebook", False)
            and getattr(self, "_source", "")
            and theme != self.theme
        ):
            raise traitlets.TraitError(
                "source-backed notebook themes are defined by the source HTML"
            )
        return theme

    @traitlets.observe("theme")
    def _sync_theme_to_spec(self, change: Any) -> None:
        if getattr(self, "_initializing_notebook", False) or self._source:
            return
        spec = dict(self._spec)
        spec["theme"] = change["new"]
        self.set_trait("_spec", spec)

    @property
    def variables(self) -> dict[str, Any]:
        return dict(self._variable_values)

    @property
    def attachments(self) -> dict[str, FileAttachment]:
        return cast(dict[str, FileAttachment], dict(self._attachments))

    def update_variables(
        self,
        values: Mapping[str, Any] | Iterable[tuple[str, Any]] | None = None,
        /,
        **kwargs: Any,
    ) -> None:
        self._require_open()
        updates = variable_updates_from_args("update_variables", values, kwargs)
        if updates:
            self._patch_variables(updates)

    def replace_variables(
        self,
        values: Mapping[str, Any] | Iterable[tuple[str, Any]] | None = None,
        /,
        **kwargs: Any,
    ) -> None:
        self._require_open()
        replacement = variable_updates_from_args("replace_variables", values, kwargs)
        prepared, serialized = self._prepare_variables(replacement)
        self._apply_variable_replacement(prepared, serialized)

    def reset_variables(self, *names: str) -> None:
        self._require_open()
        if not names:
            return
        validated_names = tuple(self._validate_variable_name(name) for name in names)
        values = dict(self._variable_values)
        serialized = dict(self._variables)
        changed = False
        for name in validated_names:
            if name in values:
                del values[name]
                serialized.pop(name, None)
                changed = True
        if changed:
            self._apply_variable_replacement(values, serialized)

    def _require_open(self) -> None:
        if self._notebook_closed:
            raise RuntimeError("Cannot mutate a closed Notebook")

    def _patch_variables(self, updates: Mapping[str, Any]) -> None:
        prepared_updates, serialized_updates = self._prepare_variables(updates)
        cleared_view_names = self._clear_view_values(serialized_updates)
        changed = {
            name: value
            for name, value in prepared_updates.items()
            if name in cleared_view_names
            or not same_wire_value(
                self._variables.get(name, _MISSING_VARIABLE), serialized_updates[name]
            )
        }
        if not changed:
            return
        changed_wire = {name: serialized_updates[name] for name in changed}
        self._variable_values = {**self._variable_values, **changed}
        self._variable_update_seq += 1
        self.set_trait(
            "_variable_update",
            {
                "seq": self._variable_update_seq,
                "kind": "set",
                "values": changed_wire,
            },
        )
        self.set_trait("_variables", {**self._variables, **changed_wire})

    def _prepare_variables(
        self, values: Mapping[str, Any] | None
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        return prepare_variables(values, reserved_names=self._reserved_variable_names)

    def _validate_variable_name(self, name: object) -> str:
        return validate_variable_name(
            name,
            reserved_names=self._reserved_variable_names,
        )

    def _apply_variable_replacement(
        self,
        values: Mapping[str, Any],
        serialized: Mapping[str, Any],
    ) -> None:
        python_names = set(self._variable_values).union(serialized)
        cleared_view_names = self._clear_view_values(python_names)
        if same_wire_value(self._variables, serialized) and not cleared_view_names:
            return
        self._variable_values = dict(values)
        wire = dict(serialized)
        self._variable_update_seq += 1
        self.set_trait(
            "_variable_update",
            {
                "seq": self._variable_update_seq,
                "kind": "replace",
                "values": wire,
            },
        )
        self.set_trait("_variables", wire)

    def _clear_view_values(self, names: Iterable[str]) -> set[str]:
        cleared_names = set(names).intersection(self._view_values)
        if cleared_names:
            self.set_trait(
                "_view_values",
                {
                    name: value
                    for name, value in self._view_values.items()
                    if name not in cleared_names
                },
            )
        return cleared_names

    def to_notebook_html(self) -> str:
        return self._source or serialize(self._spec)

    def close(self) -> None:
        if getattr(self, "_notebook_closed", False):
            return
        self._notebook_closed = True
        for view in tuple(getattr(self, "_views", ())):
            view.close()
        super().close()


class Notebook:
    """Notebook definition and Python-owned session state.

    The browser evaluates the definition through a ``NotebookView`` created by
    ``view()`` or by a ``NotebookCell`` handle.
    """

    __slots__ = ("_session", "_cell_cache")

    def __init__(
        self,
        *cells: NotebookCellInput,
        title: str = "Untitled",
        theme: str | Mapping[str, str] = "air",
        files: Mapping[str, FileInput] | None = None,
        base_path: str | pathlib.Path | None = None,
        variables: Mapping[str, Any] | None = None,
        show_pinned_source: bool = False,
    ) -> None:
        """Create a notebook from Python-authored cells."""

        model = notebook_model_from_cells(
            cells,
            title=title,
            theme=theme,
            files=files,
            base_path=base_path,
        )
        self._initialize_model(
            model,
            variables=variables,
            show_pinned_source=show_pinned_source,
        )

    @classmethod
    def _from_model(
        cls,
        model: NotebookModel,
        *,
        variables: Mapping[str, Any] | None,
        show_pinned_source: bool,
    ) -> Notebook:
        notebook = cls.__new__(cls)
        notebook._initialize_model(
            model,
            variables=variables,
            show_pinned_source=show_pinned_source,
        )
        return notebook

    def _initialize_model(
        self,
        model: NotebookModel,
        *,
        variables: Mapping[str, Any] | None,
        show_pinned_source: bool,
    ) -> None:
        self._cell_cache: dict[int, NotebookCell] = {}
        self._session = _NotebookSession(
            model,
            variables=variables,
            show_pinned_source=show_pinned_source,
        )

    @property
    def variables(self) -> dict[str, Any]:
        """Current Python-owned Observable variables."""

        return self._session.variables

    @property
    def attachments(self) -> dict[str, FileAttachment]:
        """File records registered with ``FileAttachment`` in each view."""

        return self._session.attachments

    @property
    def theme(self) -> Theme:
        """Notebook Kit theme used by each view."""

        return cast(Theme, self._session.theme)

    @theme.setter
    def theme(self, value: str | Mapping[str, str]) -> None:
        self._session.theme = value

    def update_variables(
        self,
        values: Mapping[str, Any] | Iterable[tuple[str, Any]] | None = None,
        /,
        **kwargs: Any,
    ) -> None:
        """Merge Python-owned variable updates into every active view."""

        self._session.update_variables(values, **kwargs)

    def replace_variables(
        self,
        values: Mapping[str, Any] | Iterable[tuple[str, Any]] | None = None,
        /,
        **kwargs: Any,
    ) -> None:
        """Replace the Python-owned variable environment for every active view."""

        self._session.replace_variables(values, **kwargs)

    def reset_variables(self, *names: str) -> None:
        """Release Python ownership of variables in every active view."""

        self._session.reset_variables(*names)

    @property
    def cells(self) -> tuple[NotebookCell, ...]:
        """Cell handles in notebook order."""

        return tuple(self.cell(index) for index in range(len(self._session._cell_keys)))

    def cell(self, selector: int | str) -> NotebookCell:
        """Return a cell by zero-based index or Python selection key."""

        if isinstance(selector, int) and not isinstance(selector, bool):
            count = len(self._session._cell_keys)
            index = selector if selector >= 0 else count + selector
            if index < 0 or index >= count:
                raise IndexError("notebook cell index out of range")
        elif isinstance(selector, str):
            matches = [
                index
                for index, key in enumerate(self._session._cell_keys)
                if key and key == selector
            ]
            if not matches:
                raise KeyError(f"Unknown Observable cell key: {selector!r}")
            if len(matches) > 1:
                raise KeyError(f"Ambiguous Observable cell key: {selector!r}")
            index = matches[0]
        else:
            raise TypeError("cell selector must be an integer index or string key")
        cached = self._cell_cache.get(index)
        if cached is None:
            cached = NotebookCell._create(self, index)
            self._cell_cache[index] = cached
        return cached

    def view(
        self,
        cells: Sequence[int | str | NotebookCell] | None = None,
    ) -> NotebookView:
        """Create a display model for all cells or an explicit selection."""

        self._session._require_open()
        indexes = None if cells is None else self._normalize_view_cells(cells)
        return NotebookView._create(self, indexes)

    def _normalize_view_cells(
        self, cells: Sequence[int | str | NotebookCell]
    ) -> list[int]:
        _require_sequence_container(
            cells,
            message=(
                "view cells must be a sequence of indexes, keys, or "
                "NotebookCell objects"
            ),
        )
        if len(cells) == 0:
            raise ValueError("view cells must contain at least one selection")
        indexes: list[int] = []
        for selection in cells:
            if isinstance(selection, NotebookCell):
                if selection._owner is not self:
                    raise ValueError("NotebookCell belongs to another Notebook")
                index = selection.index
            else:
                index = self.cell(selection).index
            if index in indexes:
                raise ValueError("view cells must select each notebook cell once")
            indexes.append(index)
        return sorted(indexes)

    def close(self) -> None:
        """Close the session and every live view created from it."""

        self._cell_cache.clear()
        self._session.close()

    @classmethod
    def from_html(
        cls,
        source: str,
        *,
        files: Mapping[str, FileInput] | None = None,
        base_path: str | pathlib.Path | None = None,
        embed_file_attachments: bool = False,
        rewrite_imports: bool = False,
        variables: Mapping[str, Any] | None = None,
        show_pinned_source: bool = False,
    ) -> Notebook:
        """Create a notebook from Notebook Kit HTML text."""

        model = notebook_model_from_html(
            source,
            files=files,
            base_path=base_path,
            embed_file_attachments=embed_file_attachments,
            rewrite_imports=rewrite_imports,
        )
        return cls._from_model(
            model,
            variables=variables,
            show_pinned_source=show_pinned_source,
        )

    @classmethod
    def from_observablehq(
        cls,
        specifier: str,
        *,
        variables: Mapping[str, Any] | None = None,
        files: Mapping[str, FileInput] | None = None,
        show_pinned_source: bool = False,
        timeout: float | None = 30,
    ) -> Notebook:
        """Fetch a public ObservableHQ notebook through the document API."""

        model = notebook_model_from_observablehq(
            specifier,
            files=files,
            timeout=timeout,
        )
        return cls._from_model(
            model,
            variables=variables,
            show_pinned_source=show_pinned_source,
        )

    @classmethod
    def from_observablehq_document(
        cls,
        document: ObservableDocument | Mapping[str, Any],
        *,
        title: str | None = None,
        variables: Mapping[str, Any] | None = None,
        files: Mapping[str, FileInput] | None = None,
        show_pinned_source: bool = False,
    ) -> Notebook:
        """Create a notebook from an ObservableHQ document API mapping."""

        model = notebook_model_from_observablehq_document(
            document,
            title=title,
            files=files,
        )
        return cls._from_model(
            model,
            variables=variables,
            show_pinned_source=show_pinned_source,
        )

    def to_notebook_html(self) -> str:
        """Return Notebook Kit HTML for saving or inspecting the definition."""

        return self._session.to_notebook_html()


class NotebookView(_ObservableWidget):
    """Renderable view of a notebook cell selection."""

    _owner: Notebook
    _view_closed: bool
    _session = traitlets.Instance(_NotebookSession).tag(
        sync=True,
        to_json=_WIDGET_TO_JSON,
        from_json=_WIDGET_FROM_JSON,
    )
    _cell_indexes = traitlets.Any(default_value=None, allow_none=True).tag(sync=True)
    _readback = traitlets.Dict(
        default_value={
            "revision": 0,
            "rendered": False,
            "graph": {},
            "cells": {},
        }
    ).tag(sync=True)

    def __init__(self) -> None:
        raise TypeError("NotebookView objects are created with Notebook.view()")

    @classmethod
    def _create(
        cls,
        notebook: Notebook,
        cell_indexes: Sequence[int] | None,
    ) -> NotebookView:
        notebook._session._require_open()
        view = cls.__new__(cls)
        view._owner = notebook
        view._view_closed = False
        indexes = None if cell_indexes is None else list(cell_indexes)
        _ObservableWidget.__init__(
            view,
            _session=notebook._session,
            _cell_indexes=indexes,
        )
        notebook._session._views.add(view)
        return view

    @traitlets.validate("_session")
    def _validate_session(self, proposal: Any) -> _NotebookSession:
        session = cast(_NotebookSession, proposal["value"])
        owner = getattr(self, "_owner", None)
        if owner is not None and session is not owner._session:
            raise traitlets.TraitError(
                "_session must reference the NotebookView's owning Notebook"
            )
        return session

    @traitlets.validate("_cell_indexes")
    def _validate_cell_indexes(self, proposal: Any) -> list[int] | None:
        value = proposal["value"]
        if value is None:
            return None
        if (
            not isinstance(value, list)
            or len(value) == 0
            or any(
                not isinstance(index, int)
                or isinstance(index, bool)
                or index < 0
                or index >= len(self._session._cell_keys)
                for index in value
            )
        ):
            raise traitlets.TraitError(
                "_cell_indexes must be null or a non-empty list of notebook cell indexes"
            )
        if len(value) != len(set(value)):
            raise traitlets.TraitError("_cell_indexes must contain unique indexes")
        return sorted(value)

    @traitlets.validate("_readback")
    def _validate_readback(self, proposal: Any) -> dict[str, Any]:
        value = proposal["value"]
        revision = value.get("revision")
        if (
            not isinstance(revision, int)
            or isinstance(revision, bool)
            or revision < 0
            or revision > (1 << 53) - 1
            or not isinstance(value.get("rendered"), bool)
            or not isinstance(value.get("graph"), Mapping)
            or not isinstance(value.get("cells"), Mapping)
        ):
            raise traitlets.TraitError(
                "_readback must be a revisioned browser snapshot"
            )
        current = self._trait_values.get("_readback")
        current_revision = (
            current.get("revision") if isinstance(current, Mapping) else -1
        )
        # Marimo transports model saves independently. Keep the newest browser
        # snapshot when an earlier save arrives after it.
        if isinstance(current_revision, int) and revision <= current_revision:
            return cast(dict[str, Any], current)
        return cast(dict[str, Any], value)

    @property
    def notebook(self) -> Notebook:
        """Notebook definition and session rendered by this view."""

        return self._owner

    @property
    def cells(self) -> tuple[NotebookCell, ...]:
        """Selected cell handles in notebook order."""

        indexes = (
            range(len(self._session._cell_keys))
            if self._cell_indexes is None
            else self._cell_indexes
        )
        return tuple(self._owner.cell(index) for index in indexes)

    @property
    def has_rendered(self) -> bool:
        """Whether this view has synchronized a complete browser render."""

        return self._readback.get("rendered") is True

    @property
    def has_graph_snapshot(self) -> bool:
        """Whether this view has synchronized notebook graph metadata."""

        return graph_from_raw(self._readback.get("graph")) is not None

    def _require_rendered(self) -> None:
        if not self.has_rendered:
            raise NotRenderedError(
                "NotebookView values are available after the view renders in a browser"
            )

    @property
    def graph(self) -> NotebookGraph:
        """Symbolic cell graph synchronized from this browser view."""

        graph = graph_from_raw(self._readback.get("graph"))
        if graph is None:
            raise NotRenderedError(
                "NotebookView graph metadata is available after graph synchronization"
            )
        return graph

    @property
    def values(self) -> dict[str, Any]:
        """Latest browser values with one owning cell in this view."""

        self._require_rendered()
        owners: dict[str, tuple[int, Any]] = {}
        cells = self._readback.get("cells")
        for record in cells.values() if isinstance(cells, Mapping) else ():
            if not isinstance(record, Mapping):
                continue
            values = record.get("values")
            if not isinstance(values, Mapping):
                continue
            for name, value in values.items():
                if not isinstance(name, str):
                    continue
                count, _previous = owners.get(name, (0, None))
                owners[name] = (count + 1, value)
        return {
            name: deserialize_value(value)
            for name, (count, value) in owners.items()
            if count == 1
        }

    @property
    def cell_values(self) -> tuple[CellValues, ...]:
        """Browser-synchronized values for the selected cells."""

        self._require_rendered()
        return tuple(
            CellValues(
                index=cell.index,
                key=cell.key,
                values=self._cell_values(cell.index),
            )
            for cell in self.cells
        )

    def _cell_values(self, index: int) -> dict[str, Any]:
        cells = self._readback.get("cells")
        record = cells.get(str(index)) if isinstance(cells, Mapping) else None
        values = record.get("values") if isinstance(record, Mapping) else None
        if not isinstance(values, Mapping):
            return {}
        return {
            name: deserialize_value(value)
            for name, value in values.items()
            if isinstance(name, str)
        }

    def close(self) -> None:
        """Close this display model."""

        if getattr(self, "_view_closed", False):
            return
        self._view_closed = True
        session = getattr(self, "_trait_values", {}).get("_session")
        if session is not None:
            session._views.discard(self)
        super().close()
