"""Python notebook sessions, cell handles, and renderable views."""

from __future__ import annotations

import pathlib
import types as _types
import weakref
from collections.abc import Iterable, Mapping, Sequence
from typing import Any, Unpack, cast

import anywidget
import traitlets
from anywidget_bundle import Bundle, BundledWidget

from ._cells import Cell, NotebookCellInput
from ._files import FileAttachment
from ._graph import graph_from_raw
from ._model import (
    NotebookModel,
    notebook_model_from_cells,
    notebook_model_from_html,
    notebook_model_from_observablehq,
    notebook_model_from_observablehq_document,
)
from ._serialize import serialize
from ._themes import normalize_theme
from ._variables import (
    OBSERVABLE_RESERVED_VARIABLE_NAMES,
    deserialize_value,
    prepare_variables,
    same_wire_value,
    validate_variable_name,
)
from ._view_options import (
    ResolvedNotebookViewOptions,
    resolve_notebook_view_options,
)
from .types import (
    CellError,
    CellResult,
    CellSelector,
    CellStatus,
    ErrorPhase,
    FileInput,
    FileSnapshot,
    NotebookState,
    NotebookViewOptions,
    ObservableDocument,
    Theme,
    ThemeSnapshot,
    ViewError,
    ViewState,
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
_MAX_SAFE_REVISION = (1 << 53) - 1


def _wrap_marimo(instance: Any) -> Any:
    try:
        import marimo

        if marimo.running_in_notebook():
            return marimo.ui.anywidget(instance)
    except (ImportError, ModuleNotFoundError):
        pass
    return instance


def _freeze(value: Any) -> Any:
    if isinstance(value, Mapping):
        return _types.MappingProxyType(
            {str(key): _freeze(item) for key, item in value.items()}
        )
    if isinstance(value, list | tuple):
        return tuple(_freeze(item) for item in value)
    if isinstance(value, set | frozenset):
        return frozenset(_freeze(item) for item in value)
    return value


class _ObservableWidget(BundledWidget):
    """Shared anywidget base for the bundled frontend assets."""

    bundle = _OBSERVABLE_WIDGET_BUNDLE


class NotebookCell:
    """Canonical handle for one cell owned by a ``Notebook``."""

    __slots__ = ("_index", "_owner")
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
        """Public cell identity, or ``None`` for an anonymous cell."""

        return self._owner._session._cell_keys[self._index] or None

    @property
    def id(self) -> int:
        """Notebook Kit serialization identifier."""

        return self._owner._session._cell_ids[self._index]


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
        self._cell_ids = tuple(node.id for node in model.nodes)
        self._views: weakref.WeakSet[NotebookView] = weakref.WeakSet()
        self._notebook_closed = False
        self._variable_update_seq = 0
        spec = dict(model.spec)
        if not model.source:
            spec["theme"] = model.theme
            spec["cells"] = [
                {**node.to_spec(), "pinned": node.pinned} for node in model.nodes
            ]
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
        values: Mapping[str, object],
        /,
    ) -> bool:
        self._require_open()
        if not isinstance(values, Mapping):
            raise TypeError("update_variables expects one mapping")
        return bool(values) and self._patch_variables(values)

    def replace_variables(
        self,
        values: Mapping[str, object],
        /,
    ) -> bool:
        self._require_open()
        if not isinstance(values, Mapping):
            raise TypeError("replace_variables expects one mapping")
        prepared, serialized = self._prepare_variables(values)
        return self._apply_variable_replacement(prepared, serialized)

    def reset_variables(self, *names: str) -> bool:
        self._require_open()
        if not names:
            return False
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
            return self._apply_variable_replacement(values, serialized)
        return False

    def _require_open(self) -> None:
        if self._notebook_closed:
            raise RuntimeError("Cannot mutate a closed Notebook")

    def _patch_variables(self, updates: Mapping[str, Any]) -> bool:
        prepared_updates, serialized_updates = self._prepare_variables(updates)
        cleared_view_names = set(serialized_updates).intersection(self._view_values)
        changed = {
            name: value
            for name, value in prepared_updates.items()
            if name in cleared_view_names
            or not same_wire_value(
                self._variables.get(name, _MISSING_VARIABLE), serialized_updates[name]
            )
        }
        if not changed:
            return False
        changed_wire = {name: serialized_updates[name] for name in changed}
        self._variable_values = {**self._variable_values, **changed}
        self._variable_update_seq += 1
        with self.hold_sync():
            self._clear_view_values(serialized_updates)
            self.set_trait("_variables", {**self._variables, **changed_wire})
            self.set_trait(
                "_variable_update",
                {
                    "seq": self._variable_update_seq,
                    "kind": "set",
                    "values": changed_wire,
                },
            )
        return True

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
    ) -> bool:
        python_names = set(self._variable_values).union(serialized)
        cleared_view_names = python_names.intersection(self._view_values)
        if same_wire_value(self._variables, serialized) and not cleared_view_names:
            return False
        self._variable_values = dict(values)
        wire = dict(serialized)
        self._variable_update_seq += 1
        with self.hold_sync():
            self._clear_view_values(python_names)
            self.set_trait("_variables", wire)
            self.set_trait(
                "_variable_update",
                {
                    "seq": self._variable_update_seq,
                    "kind": "replace",
                    "values": wire,
                },
            )
        return True

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


class Notebook(traitlets.HasTraits):
    """Notebook definition and Python-owned session state.

    ``state`` is a detached read-only snapshot. Observe that trait in reactive
    environments and use the mutation methods to change variables or ``theme``.
    """

    state: NotebookState = cast(Any, traitlets.Any(read_only=True))

    def __init__(
        self,
        *cells: NotebookCellInput,
        title: str = "Untitled",
        theme: Theme = "air",
        files: Mapping[str, FileInput] | None = None,
        base_path: str | pathlib.Path | None = None,
        variables: Mapping[str, object] | None = None,
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
        variables: Mapping[str, object] | None,
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
        variables: Mapping[str, object] | None,
        show_pinned_source: bool,
    ) -> None:
        traitlets.HasTraits.__init__(self)
        self._cell_cache: dict[int, NotebookCell] = {}
        self._session = _NotebookSession(
            model,
            variables=variables,
            show_pinned_source=show_pinned_source,
        )
        self._publish_state()

    def _publish_state(self) -> None:
        variables = deserialize_value(self._session._variables)
        snapshot = NotebookState(
            variables=cast(Mapping[str, object], _freeze(variables)),
            attachments=cast(
                Mapping[str, FileSnapshot],
                _freeze(dict(self._session._attachments)),
            ),
            theme=cast(ThemeSnapshot, _freeze(self._session.theme)),
        )
        self.set_trait("state", snapshot)

    @property
    def variables(self) -> Mapping[str, object]:
        """Detached read-only snapshot of Python-owned variables.

        Mutating construction inputs does not change the session. The snapshot
        cannot update the notebook. Use ``update_variables``,
        ``replace_variables``, or ``reset_variables`` for writes and observe
        ``state`` in reactive environments.
        """

        return self.state.variables

    @property
    def attachments(self) -> Mapping[str, FileSnapshot]:
        """Detached read-only snapshot of normalized file records.

        Mutating construction inputs does not change the session. The snapshot
        cannot update the notebook. Create a new notebook to change attachments
        and observe ``state`` in reactive environments.
        """

        return self.state.attachments

    @property
    def theme(self) -> ThemeSnapshot:
        """Immutable snapshot of the Notebook Kit theme.

        Mutating construction inputs does not change the session. Assign this
        property to update the notebook and observe ``state`` in reactive
        environments.
        """

        return self.state.theme

    @theme.setter
    def theme(self, value: Theme) -> None:
        previous = self._session.theme
        self._session.theme = value
        if previous != self._session.theme:
            self._publish_state()

    def update_variables(
        self,
        values: Mapping[str, object],
        /,
    ) -> None:
        """Merge Python-owned variable updates into every active view."""

        if self._session.update_variables(values):
            self._publish_state()

    def replace_variables(
        self,
        values: Mapping[str, object],
        /,
    ) -> None:
        """Replace the Python-owned variable environment for every active view."""

        if self._session.replace_variables(values):
            self._publish_state()

    def reset_variables(self, *names: str) -> None:
        """Release Python ownership of variables in every active view."""

        if self._session.reset_variables(*names):
            self._publish_state()

    @property
    def cells(self) -> tuple[NotebookCell, ...]:
        """Cell handles in notebook order."""

        return tuple(
            self._cell_at(index) for index in range(len(self._session._cell_keys))
        )

    def cell(self, key: str) -> NotebookCell:
        """Return the cell identified by the unique public ``key``."""

        if not isinstance(key, str):
            raise TypeError("cell key must be a string")
        matches = [
            index
            for index, candidate in enumerate(self._session._cell_keys)
            if candidate and candidate == key
        ]
        if not matches:
            raise KeyError(f"Unknown Observable cell key: {key!r}")
        if len(matches) > 1:
            raise KeyError(f"Ambiguous Observable cell key: {key!r}")
        return self._cell_at(matches[0])

    def _cell_at(self, index: int) -> NotebookCell:
        cached = self._cell_cache.get(index)
        if cached is None:
            cached = NotebookCell._create(self, index)
            self._cell_cache[index] = cached
        return cached

    def view(
        self,
        *selectors: CellSelector,
        **options: Unpack[NotebookViewOptions],
    ) -> NotebookView:
        """Create one view for all cells or positional cell selectors.

        Selectors may be keys, keyed authored ``Cell`` objects, or
        ``NotebookCell`` handles from this notebook. Selected outputs render in
        notebook order. In a running marimo notebook, the returned UI element
        proxies the underlying ``NotebookView``.

        Use ``capture_state=False`` when the rendered output is all the caller
        needs. The view remains interactive while ``NotebookView.state`` stays
        at its initial value.
        """

        return self._create_view(selectors, resolve_notebook_view_options(options))

    def _create_view(
        self,
        selectors: Sequence[CellSelector],
        options: ResolvedNotebookViewOptions,
    ) -> NotebookView:
        self._session._require_open()
        indexes = None if not selectors else self._normalize_view_cells(selectors)
        return _wrap_marimo(
            NotebookView._create(
                self,
                indexes,
                options=options,
            )
        )

    def _normalize_view_cells(self, selectors: Sequence[CellSelector]) -> list[int]:
        indexes: list[int] = []
        for selection in selectors:
            if isinstance(selection, NotebookCell):
                if selection._owner is not self:
                    raise ValueError("NotebookCell belongs to another Notebook")
                index = selection.index
            elif isinstance(selection, Cell):
                if selection.key is None:
                    raise ValueError("authored cell selectors require a key")
                index = self.cell(selection.key).index
            elif isinstance(selection, str):
                index = self.cell(selection).index
            else:
                raise TypeError("cell selector must be a key, Cell, or NotebookCell")
            if index in indexes:
                raise ValueError("view selectors must identify distinct cells")
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
        variables: Mapping[str, object] | None = None,
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
        variables: Mapping[str, object] | None = None,
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
        document: ObservableDocument,
        *,
        title: str | None = None,
        variables: Mapping[str, object] | None = None,
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
    """Renderable view with structured browser evaluation ``state``."""

    _owner: Notebook
    _owns_notebook: bool
    _view_closed: bool
    _session = traitlets.Instance(_NotebookSession).tag(
        sync=True,
        to_json=_WIDGET_TO_JSON,
        from_json=_WIDGET_FROM_JSON,
    )
    _cell_indexes = traitlets.Any(default_value=None, allow_none=True).tag(sync=True)
    _capture_state = traitlets.Bool(default_value=True).tag(sync=True)
    _readback = traitlets.Dict(
        default_value={
            "revision": 0,
            "input_revision": None,
            "settled_revision": None,
            "pending": False,
            "graph": {},
            "results": {},
            "errors": [],
        }
    ).tag(sync=True)
    state: ViewState = cast(Any, traitlets.Any(read_only=True))

    def __init__(self) -> None:
        raise TypeError("NotebookView objects are created with Notebook.view()")

    @classmethod
    def _create(
        cls,
        notebook: Notebook,
        cell_indexes: Sequence[int] | None,
        *,
        options: ResolvedNotebookViewOptions,
    ) -> NotebookView:
        notebook._session._require_open()
        view = cls.__new__(cls)
        view._owner = notebook
        view._owns_notebook = False
        view._view_closed = False
        indexes = None if cell_indexes is None else list(cell_indexes)
        _ObservableWidget.__init__(
            view,
            _session=notebook._session,
            _cell_indexes=indexes,
            _capture_state=options.capture_state,
        )
        view.set_trait("state", view._state_from_readback(view._readback))
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
        value = _validate_readback_wire(proposal["value"], self._selected_indexes())
        revision = cast(int, value["revision"])
        current = self._trait_values.get("_readback")
        current_revision = (
            current.get("revision") if isinstance(current, Mapping) else -1
        )
        # Marimo transports model saves independently. Keep the newest browser
        # snapshot when an earlier save arrives after it.
        if isinstance(current_revision, int) and revision <= current_revision:
            return cast(dict[str, Any], current)
        return value

    @traitlets.observe("_readback")
    def _publish_readback_state(self, change: Any) -> None:
        if not hasattr(self, "_owner") or not self._capture_state:
            return
        self.set_trait("state", self._state_from_readback(change["new"]))

    def _selected_indexes(self) -> tuple[int, ...]:
        indexes = self._trait_values.get("_cell_indexes")
        if indexes is None:
            return tuple(range(len(self._session._cell_keys)))
        return tuple(cast(Sequence[int], indexes))

    def _state_from_readback(self, value: Mapping[str, Any]) -> ViewState:
        raw_results = cast(Mapping[str, Any], value["results"])
        results: list[CellResult] = []
        for index in self._selected_indexes():
            raw = raw_results.get(str(index))
            if not isinstance(raw, Mapping):
                continue
            errors = tuple(
                _cell_error_from_wire(item)
                for item in cast(Sequence[Any], raw["errors"])
            )
            decoded = {
                name: deserialize_value(item)
                for name, item in cast(Mapping[str, Any], raw["values"]).items()
            }
            results.append(
                CellResult(
                    cell=self._owner._cell_at(index),
                    revision=cast(int, raw["revision"]),
                    status=cast(CellStatus, raw["status"]),
                    values=cast(Mapping[str, object], _freeze(decoded)),
                    errors=errors,
                )
            )
        view_errors = tuple(
            _view_error_from_wire(item) for item in cast(Sequence[Any], value["errors"])
        )
        return ViewState(
            input_revision=cast(int | None, value["input_revision"]),
            settled_revision=cast(int | None, value["settled_revision"]),
            pending=cast(bool, value["pending"]),
            results=tuple(results),
            errors=view_errors,
            graph=graph_from_raw(value["graph"]),
        )

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
        return tuple(self._owner._cell_at(index) for index in indexes)

    def close(self) -> None:
        """Close this display model."""

        if getattr(self, "_view_closed", False):
            return
        self._view_closed = True
        owner = (
            getattr(self, "_owner", None)
            if getattr(self, "_owns_notebook", False)
            else None
        )
        session = getattr(self, "_trait_values", {}).get("_session")
        if session is not None:
            session._views.discard(self)
        super().close()
        if owner is not None:
            owner.close()


def _validate_readback_wire(
    value: object, selected_indexes: Sequence[int]
) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise traitlets.TraitError("_readback must be a mapping")
    value = cast(Mapping[str, object], value)
    required = {
        "revision",
        "input_revision",
        "settled_revision",
        "pending",
        "graph",
        "results",
        "errors",
    }
    if set(value) != required:
        raise traitlets.TraitError("_readback has an invalid field set")
    revision = _wire_revision(value["revision"], "revision")
    input_revision = _optional_wire_revision(value["input_revision"], "input_revision")
    settled_revision = _optional_wire_revision(
        value["settled_revision"], "settled_revision"
    )
    pending = value["pending"]
    raw_graph = value["graph"]
    raw_results = value["results"]
    raw_errors = value["errors"]
    if not isinstance(pending, bool):
        raise traitlets.TraitError("_readback pending must be a boolean")
    if not isinstance(raw_graph, Mapping):
        raise traitlets.TraitError("_readback graph must be a mapping")
    if not isinstance(raw_results, Mapping):
        raise traitlets.TraitError("_readback results must be a mapping")
    if not isinstance(raw_errors, list | tuple):
        raise traitlets.TraitError("_readback errors must be a list")
    if input_revision is None:
        if settled_revision is not None or pending or raw_results:
            raise traitlets.TraitError("idle readback state is inconsistent")
    else:
        if settled_revision is not None and settled_revision > input_revision:
            raise traitlets.TraitError("settled_revision cannot exceed input_revision")
        if pending and settled_revision == input_revision:
            raise traitlets.TraitError("pending readback cannot be settled")
        if not pending and settled_revision != input_revision:
            raise traitlets.TraitError("non-pending readback must be settled")
    selected = set(selected_indexes)
    results: dict[str, Any] = {}
    pending_results = 0
    for raw_index, raw_result in raw_results.items():
        if not isinstance(raw_index, str) or not raw_index.isdecimal():
            raise traitlets.TraitError("readback result keys must be cell indexes")
        index = int(raw_index)
        if index not in selected:
            raise traitlets.TraitError("readback contains an unselected cell result")
        result = _validate_result_wire(raw_result, input_revision)
        if result["status"] == "pending":
            pending_results += 1
        results[raw_index] = result
    if (
        input_revision is not None
        and set(map(int, results)) != selected
        and not raw_errors
    ):
        raise traitlets.TraitError(
            "evaluating readback must contain every selected cell"
        )
    if pending != (pending_results > 0):
        raise traitlets.TraitError("readback pending state does not match results")
    errors = [_validate_error_wire(item, cell=False) for item in raw_errors]
    graph = _validate_graph_wire(raw_graph)
    return {
        "revision": revision,
        "input_revision": input_revision,
        "settled_revision": settled_revision,
        "pending": pending,
        "graph": dict(graph),
        "results": results,
        "errors": errors,
    }


def _validate_graph_wire(value: Mapping[Any, Any]) -> dict[str, Any]:
    if not value:
        return {}
    if set(value) != {"cells", "edges"}:
        raise traitlets.TraitError("_readback graph has an invalid field set")
    raw_cells = value["cells"]
    raw_edges = value["edges"]
    if not isinstance(raw_cells, list | tuple) or not isinstance(
        raw_edges, list | tuple
    ):
        raise traitlets.TraitError("_readback graph cells and edges must be lists")

    required_cell_fields = {
        "id",
        "index",
        "key",
        "mode",
        "defines",
        "references",
        "output",
        "outputs",
        "runtime_outputs",
        "autodisplay",
        "autoview",
        "automutable",
    }
    cells: list[dict[str, Any]] = []
    ids: set[int] = set()
    indexes: set[int] = set()
    for item in raw_cells:
        if not isinstance(item, Mapping):
            raise traitlets.TraitError("graph cells must be mappings")
        item = cast(Mapping[Any, Any], item)
        fields = set(item)
        if (
            fields - (required_cell_fields | {"error"})
            or not required_cell_fields <= fields
        ):
            raise traitlets.TraitError("graph cell has an invalid shape")
        cell_id = _wire_revision(item["id"], "graph cell id")
        index = _wire_revision(item["index"], "graph cell index")
        key = item["key"]
        mode = item["mode"]
        output = item["output"]
        error = item.get("error")
        if cell_id == 0:
            raise traitlets.TraitError("graph cell id must be positive")
        if cell_id in ids or index in indexes:
            raise traitlets.TraitError("graph cell ids and indexes must be unique")
        if not isinstance(key, str) or not isinstance(mode, str) or not mode:
            raise traitlets.TraitError("graph cell key and mode must be strings")
        if output is not None and not isinstance(output, str):
            raise traitlets.TraitError("graph cell output must be a string or null")
        if error is not None and not isinstance(error, str):
            raise traitlets.TraitError("graph cell error must be a string")
        sequences = {
            field: _validate_string_sequence(item[field], f"graph cell {field}")
            for field in ("defines", "references", "outputs", "runtime_outputs")
        }
        flags = {}
        for field in ("autodisplay", "autoview", "automutable"):
            flag = item[field]
            if not isinstance(flag, bool):
                raise traitlets.TraitError(f"graph cell {field} must be a boolean")
            flags[field] = flag
        ids.add(cell_id)
        indexes.add(index)
        cells.append(
            {
                "id": cell_id,
                "index": index,
                "key": key,
                "mode": mode,
                **sequences,
                "output": output,
                **flags,
                **({"error": error} if error is not None else {}),
            }
        )

    edges: list[dict[str, Any]] = []
    for item in raw_edges:
        if not isinstance(item, Mapping) or set(item) != {
            "from",
            "to",
            "variable",
        }:
            raise traitlets.TraitError("graph edge has an invalid shape")
        item = cast(Mapping[Any, Any], item)
        source = _wire_revision(item["from"], "graph edge source")
        target = _wire_revision(item["to"], "graph edge target")
        variable = item["variable"]
        if source not in ids or target not in ids:
            raise traitlets.TraitError("graph edge must reference known cells")
        if not isinstance(variable, str) or not variable:
            raise traitlets.TraitError("graph edge variable must be a non-empty string")
        edges.append({"from": source, "to": target, "variable": variable})
    return {"cells": cells, "edges": edges}


def _validate_string_sequence(value: object, field: str) -> list[str]:
    if not isinstance(value, list | tuple) or any(
        not isinstance(item, str) for item in value
    ):
        raise traitlets.TraitError(f"{field} must be a list of strings")
    return cast(list[str], list(value))


def _validate_result_wire(value: object, input_revision: int | None) -> dict[str, Any]:
    if not isinstance(value, Mapping) or set(value) != {
        "revision",
        "status",
        "values",
        "errors",
    }:
        raise traitlets.TraitError("cell result has an invalid shape")
    value = cast(Mapping[str, object], value)
    revision = _wire_revision(value["revision"], "cell result revision")
    if input_revision is None or revision > input_revision:
        raise traitlets.TraitError("cell result revision is newer than the input")
    status = value["status"]
    if status not in {"pending", "success", "error"}:
        raise traitlets.TraitError("cell result has an invalid status")
    values = value["values"]
    raw_errors = value["errors"]
    if not isinstance(values, Mapping) or any(
        not isinstance(name, str) for name in values
    ):
        raise traitlets.TraitError("cell result values must use string keys")
    if not isinstance(raw_errors, list | tuple):
        raise traitlets.TraitError("cell result errors must be a list")
    errors = [_validate_error_wire(item, cell=True) for item in raw_errors]
    if status == "error" and not errors:
        raise traitlets.TraitError("error results require a structured error")
    if status != "error" and errors:
        raise traitlets.TraitError("structured cell errors require error status")
    if status == "pending" and values:
        raise traitlets.TraitError("pending results cannot expose values")
    return {
        "revision": revision,
        "status": status,
        "values": dict(values),
        "errors": errors,
    }


def _validate_error_wire(value: object, *, cell: bool) -> dict[str, Any]:
    required = {"name", "message", "phase"}
    allowed = required | ({"variable"} if cell else set())
    if (
        not isinstance(value, Mapping)
        or set(value) - allowed
        or not required <= set(value)
    ):
        raise traitlets.TraitError("structured error has an invalid shape")
    value = cast(Mapping[str, object], value)
    name = value["name"]
    message = value["message"]
    phase = value["phase"]
    variable = value.get("variable")
    if not isinstance(name, str) or not name or not isinstance(message, str):
        raise traitlets.TraitError("structured error name and message are required")
    if phase not in {"analysis", "evaluation", "rendering", "serialization"}:
        raise traitlets.TraitError("structured error phase is invalid")
    if variable is not None and not isinstance(variable, str):
        raise traitlets.TraitError("structured error variable must be a string")
    result: dict[str, Any] = {"name": name, "message": message, "phase": phase}
    if cell:
        result["variable"] = variable
    return result


def _cell_error_from_wire(value: object) -> CellError:
    error = _validate_error_wire(value, cell=True)
    return CellError(
        name=cast(str, error["name"]),
        message=cast(str, error["message"]),
        phase=cast(ErrorPhase, error["phase"]),
        variable=cast(str | None, error["variable"]),
    )


def _view_error_from_wire(value: object) -> ViewError:
    error = _validate_error_wire(value, cell=False)
    return ViewError(
        name=cast(str, error["name"]),
        message=cast(str, error["message"]),
        phase=cast(ErrorPhase, error["phase"]),
    )


def _wire_revision(value: object, field: str) -> int:
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or value < 0
        or value > _MAX_SAFE_REVISION
    ):
        raise traitlets.TraitError(f"{field} must be a safe non-negative integer")
    return value


def _optional_wire_revision(value: object, field: str) -> int | None:
    return None if value is None else _wire_revision(value, field)
