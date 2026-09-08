"""Python notebook sessions, cell handles, and renderable views."""

from __future__ import annotations

import pathlib
import weakref
from collections.abc import Iterable, Mapping, Sequence
from types import MappingProxyType
from typing import Any, Unpack, cast

import anywidget
import traitlets
from anywidget_bundle import Bundle, BundledWidget

from . import errors
from ._cells import Cell, NotebookCellInput
from ._files import FileAttachment
from ._graph import graph_from_raw
from ._inspection import (
    DatasetInfo,
    NotebookInspection,
    NotebookRead,
    ReadFormat,
    decode_datasets,
    decode_inspection,
    decode_read,
)
from ._model import (
    NotebookModel,
    notebook_model_from_cells,
    notebook_model_from_html,
    notebook_model_from_observablehq_document,
)
from ._observable import fetch_observablehq_document
from ._readback import (
    _cell_error_from_wire,
    _view_error_from_wire,
    validate_readback_wire,
)
from ._requests import ViewRequests
from ._serialize import RuntimeProfile, serialize
from ._themes import normalize_theme
from ._variables import (
    OBSERVABLE_RESERVED_VARIABLE_NAMES,
    deserialize_value,
    freeze_value,
    prepare_variables,
    same_wire_value,
    validate_variable_name,
)
from ._view_options import (
    ResolvedNotebookViewOptions,
    resolve_notebook_view_options,
)
from .types import (
    CellResult,
    CellSelector,
    CellStatus,
    FileInput,
    FileSnapshot,
    NotebookState,
    NotebookViewOptions,
    ObservableDocument,
    Theme,
    ThemeSnapshot,
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


def _wrap_marimo(instance: Any) -> Any:
    try:
        import marimo

        if marimo.running_in_notebook():
            return marimo.ui.anywidget(instance)
    except (ImportError, ModuleNotFoundError):
        pass
    return instance


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

    @property
    def source(self) -> str:
        """Prepared Notebook Kit source for this cell."""

        return self._owner._nodes[self._index].value

    @property
    def mode(self) -> str:
        return self._owner._nodes[self._index].mode

    @property
    def hidden(self) -> bool:
        return self._owner._nodes[self._index].hidden

    @property
    def pinned(self) -> bool:
        return self._owner._nodes[self._index].pinned

    @property
    def output(self) -> str | None:
        return self._owner._nodes[self._index].output

    @property
    def database(self) -> str | None:
        return self._owner._nodes[self._index].database


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
        self._nodes = model.nodes
        self._source_document: Mapping[str, object] | None = None
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
            variables=cast(Mapping[str, object], freeze_value(variables)),
            attachments=cast(
                Mapping[str, FileSnapshot],
                freeze_value(dict(self._session._attachments)),
            ),
            theme=cast(ThemeSnapshot, freeze_value(self._session.theme)),
        )
        self.set_trait("state", snapshot)

    def _publish_variables(self, names: Iterable[str] | None = None) -> None:
        previous = self.state
        wire = self._session._variables
        if names is None:
            variables = freeze_value(deserialize_value(wire))
        else:
            values = dict(previous.variables)
            for name in names:
                if name in wire:
                    values[name] = freeze_value(deserialize_value(wire[name]))
                else:
                    values.pop(name, None)
            variables = MappingProxyType(values)
        self.set_trait(
            "state", NotebookState(variables, previous.attachments, previous.theme)
        )

    @property
    def runtime_profile(self) -> RuntimeProfile:
        """The Notebook Kit or classic Observable runtime used by this notebook."""

        return cast(RuntimeProfile, self._session._runtime_profile)

    @property
    def source_document(self) -> Mapping[str, object] | None:
        """Detached original Observable document, or ``None`` for other sources.

        This snapshot retains original nodes, data operations, and provenance.
        ``NotebookCell.source`` contains the prepared Notebook Kit cell source.
        """

        return self._source_document

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
        with self._session.hold_sync():
            self._session.theme = value
        if previous != self._session.theme:
            self.set_trait(
                "state",
                NotebookState(
                    self.state.variables,
                    self.state.attachments,
                    freeze_value(self._session.theme),
                ),
            )

    def update_variables(
        self,
        values: Mapping[str, object],
        /,
    ) -> None:
        """Merge Python-owned variable updates into every active view."""

        if self._session.update_variables(values):
            self._publish_variables(self._session._variable_update["values"])

    def replace_variables(
        self,
        values: Mapping[str, object],
        /,
    ) -> None:
        """Replace the Python-owned variable environment for every active view."""

        if self._session.replace_variables(values):
            self._publish_variables()

    def reset_variables(self, *names: str) -> None:
        """Release Python ownership of variables in every active view."""

        if self._session.reset_variables(*names):
            self._publish_variables(names)

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

        document = fetch_observablehq_document(specifier, timeout=timeout)
        return cls.from_observablehq_document(
            document,
            files=files,
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
        notebook = cls._from_model(
            model,
            variables=variables,
            show_pinned_source=show_pinned_source,
        )
        notebook._source_document = freeze_value(document)
        return notebook

    def to_notebook_html(self) -> str:
        """Return Notebook Kit HTML for saving or inspecting the definition."""

        return self._session.to_notebook_html()


class NotebookView(_ObservableWidget):
    """Renderable view with structured browser evaluation ``state``."""

    _owner: Notebook
    _owns_notebook: bool
    _view_closed: bool
    _requests: ViewRequests
    _inspection_snapshot: tuple[dict[str, object], NotebookInspection | None] | None = (
        None
    )
    _datasets_snapshot: tuple[Mapping[str, object], tuple[DatasetInfo, ...]] | None = (
        None
    )
    _accepted_readback: dict[str, Any] | None = None
    _accepted_diagnostics: dict[str, Any] | None = None
    _diagnostic_snapshot: (
        tuple[dict[str, Any], tuple[errors.Diagnostic, ...]] | None
    ) = None
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
    inspection: NotebookInspection | None = cast(
        Any, traitlets.Any(default_value=None, read_only=True)
    )
    datasets: tuple[DatasetInfo, ...] = cast(
        Any, traitlets.Any(default_value=(), read_only=True)
    )
    _inspection = traitlets.Dict(default_value={}).tag(sync=True)
    _datasets = traitlets.Dict(default_value={}).tag(sync=True)
    _diagnostics = traitlets.Dict(default_value={}).tag(sync=True)
    diagnostics: tuple[errors.Diagnostic, ...] = cast(
        Any, traitlets.Any(default_value=(), read_only=True)
    )

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
        view._requests = ViewRequests(view)
        view._accepted_readback = view._readback
        view.set_trait("state", view._state_from_readback(view._readback))
        notebook._session._views.add(view)
        return view

    def set_state(self, sync_data: dict[str, Any]) -> None:
        if not isinstance(sync_data, Mapping):
            raise self._protocol_failure(
                TypeError("Browser state must be a mapping"), "receive state"
            )
        try:
            super().set_state(sync_data)
        except errors.ProtocolError:
            raise
        except (traitlets.TraitError, TypeError, ValueError, KeyError) as cause:
            raise self._protocol_failure(cause, "receive state") from cause

    def _protocol_failure(
        self, cause: Exception, operation: str
    ) -> errors.ProtocolError:
        diagnostic = errors.Diagnostic(
            name=type(cause).__name__,
            message=str(cause),
            origin="widget",
            phase="transport",
            component="packages/pyobservablejs/src/observablejs/_notebook.py",
            operation=operation,
        )
        failure = errors.ProtocolError(
            f"Invalid notebook {operation}", diagnostics=(diagnostic,)
        )
        requests = getattr(self, "_requests", None)
        if requests is not None:
            requests.fail(failure)
        return failure

    @traitlets.validate("_diagnostics")
    def _validate_diagnostics(self, proposal: Any) -> dict[str, Any]:
        try:
            value = proposal["value"]
            current = self._accepted_diagnostics
            if not isinstance(value, Mapping):
                raise TypeError("Diagnostics must be a mapping")
            if not value:
                return current or {}
            if set(value) != {"revision", "sequence", "errors"}:
                raise ValueError("Diagnostics have an invalid field set")
            revision, sequence = value["revision"], value["sequence"]
            if type(revision) is not int or not 1 <= revision <= (1 << 53) - 1:
                raise ValueError("Diagnostic revision must be a positive safe integer")
            if type(sequence) is not int or not 0 <= sequence <= (1 << 53) - 1:
                raise ValueError(
                    "Diagnostic sequence must be a nonnegative safe integer"
                )
            if not isinstance(value["errors"], list | tuple):
                raise TypeError("Diagnostic errors must be a list")
            diagnostics = tuple(
                errors._diagnostic_from_wire(item) for item in value["errors"]
            )
            if current is not None and revision <= current["revision"]:
                return current
            wire = dict(value)
            self._diagnostic_snapshot = wire, diagnostics
            return wire
        except errors.ProtocolError:
            raise
        except (TypeError, ValueError, traitlets.TraitError) as cause:
            raise self._protocol_failure(cause, "diagnostics") from cause

    @traitlets.observe("_diagnostics")
    def _publish_diagnostics(self, change: Any) -> None:
        value = self._diagnostics
        if not value or self._view_closed:
            return
        self._accepted_diagnostics = value
        cached = self._diagnostic_snapshot
        diagnostics = (
            cached[1]
            if cached is not None and cached[0] is value
            else tuple(errors._diagnostic_from_wire(item) for item in value["errors"])
        )
        self.set_trait("diagnostics", diagnostics)

    def _diagnostics_current(self) -> bool:
        current = self._accepted_diagnostics
        return current is not None and (
            current["sequence"] >= self._session._variable_update_seq
            or (
                self.inspection is None
                and self._requests.generation is None
                and any(
                    item.cell is None and errors._is_fatal(item)
                    for item in self.diagnostics
                )
            )
        )

    def raise_for_errors(self) -> None:
        """Raise current browser diagnostics at an explicit Python checkpoint."""

        if self.diagnostics:
            raise errors._exception_for(self.diagnostics)
        if self._accepted_diagnostics is None:
            diagnostics = _captured_diagnostics(self.state)
            if diagnostics:
                raise errors._exception_for(diagnostics)

    async def ready(self, *, timeout: float | None = 30) -> ViewState:
        """Wait for current Python updates and browser evaluation, then check errors.

        Requires ``capture_state=True``. Returns the settled state snapshot.
        """

        if not self._capture_state:
            raise ValueError("ready() requires capture_state=True")
        sequence = self._session._variable_update_seq
        try:
            reply = await self._requests.request(
                {"operation": "ready", "sequence": sequence},
                timeout,
            )
        except errors.ObservableError as failure:
            if not failure.diagnostics and self._diagnostics_current():
                self.raise_for_errors()
            raise
        value = reply.result
        if (
            not isinstance(value, Mapping)
            or set(value) != {"ready", "readback", "diagnostics"}
            or reply.buffers
        ):
            raise self._protocol_failure(
                ValueError("Invalid readiness acknowledgment"), "readiness response"
            )
        acknowledgment = cast(Mapping[str, object], value)
        if (
            acknowledgment["ready"] is not True
            or not isinstance(acknowledgment["readback"], Mapping)
            or not acknowledgment["readback"]
            or not isinstance(acknowledgment["diagnostics"], Mapping)
            or not acknowledgment["diagnostics"]
        ):
            raise self._protocol_failure(
                ValueError("Invalid readiness acknowledgment"), "readiness response"
            )
        self.set_state(
            {
                "_readback": acknowledgment["readback"],
                "_diagnostics": acknowledgment["diagnostics"],
            }
        )
        if self._accepted_readback is None or self.state.input_revision is None:
            raise self._protocol_failure(
                ValueError("Readiness acknowledgment has no evaluation state"),
                "readiness response",
            )
        state = self.state
        if (
            sequence != self._session._variable_update_seq
            and not self._diagnostics_current()
        ):
            raise errors.StaleViewError(
                "Python updates superseded the readiness checkpoint"
            )
        if state.pending or state.settled_revision != state.input_revision:
            raise errors.StaleViewError(
                "Notebook changed after the readiness checkpoint"
            )
        if self._diagnostics_current() or self._accepted_diagnostics is None:
            self.raise_for_errors()
        return state

    @traitlets.validate("_inspection")
    def _validate_inspection(self, proposal: Any) -> dict[str, object]:
        try:
            value = _metadata_wire(proposal["value"], "value")
            inspection = (
                decode_inspection(value["value"], self._owner)
                if value and value["value"] is not None
                else None
            )
            datasets = self._trait_values.get("_datasets", {})
            if value and datasets and value["generation"] == datasets.get("generation"):
                self._datasets_snapshot = (
                    datasets,
                    decode_datasets(
                        datasets["values"],
                        self._owner,
                        str(value["generation"]),
                        self._requests.identity,
                    ),
                )
            self._inspection_snapshot = value, inspection
            return value
        except errors.ProtocolError:
            raise
        except (TypeError, ValueError, traitlets.TraitError) as cause:
            raise self._protocol_failure(cause, "inspection metadata") from cause

    @traitlets.validate("_datasets")
    def _validate_datasets(self, proposal: Any) -> dict[str, object]:
        try:
            value = _metadata_wire(proposal["value"], "values")
            self._datasets_snapshot = None
            inspection = self._trait_values.get("_inspection", {})
            if (
                value
                and inspection
                and value["generation"] == inspection.get("generation")
            ):
                self._datasets_snapshot = (
                    value,
                    decode_datasets(
                        value["values"],
                        self._owner,
                        str(value["generation"]),
                        self._requests.identity,
                    ),
                )
            return value
        except errors.ProtocolError:
            raise
        except (TypeError, ValueError, traitlets.TraitError) as cause:
            raise self._protocol_failure(cause, "dataset metadata") from cause

    @traitlets.observe("_inspection")
    def _publish_inspection(self, change: Any) -> None:
        value = self._inspection
        inspection = None
        if not self._view_closed and value and value["value"] is not None:
            cached = self._inspection_snapshot
            inspection = (
                cached[1]
                if cached is not None and cached[0] is value
                else decode_inspection(value["value"], self._owner)
            )
        with self.hold_trait_notifications():
            self.set_trait("inspection", inspection)
            self._publish_datasets()

    @traitlets.observe("_datasets")
    def _publish_datasets(self, change: Any = None) -> None:
        inspection = self._trait_values.get("_inspection", {})
        value = self._trait_values.get("_datasets", {})
        datasets = ()
        if (
            not self._view_closed
            and inspection
            and value
            and inspection["generation"] == value["generation"]
        ):
            cached = self._datasets_snapshot
            datasets = (
                cached[1]
                if cached is not None and cached[0] is value
                else decode_datasets(
                    value["values"],
                    self._owner,
                    value["generation"],
                    self._requests.identity,
                )
            )
        self.set_trait("datasets", datasets)

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
        try:
            value = validate_readback_wire(proposal["value"], self._selected_indexes())
            revision = cast(int, value["revision"])
            current = self._accepted_readback
            current_revision = (
                current.get("revision") if isinstance(current, Mapping) else -1
            )
            # ipywidgets batches incoming traits before cross-validation. Compare
            # against the last published wire state, not the staged trait value.
            if isinstance(current_revision, int) and revision <= current_revision:
                return cast(dict[str, Any], current)
            return value
        except errors.ProtocolError:
            raise
        except (TypeError, ValueError, traitlets.TraitError) as cause:
            raise self._protocol_failure(cause, "readback") from cause

    @traitlets.observe("_readback")
    def _publish_readback_state(self, change: Any) -> None:
        self._accepted_readback = change["new"]
        if not hasattr(self, "_owner") or not self._capture_state or self._view_closed:
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
                    values=cast(Mapping[str, object], freeze_value(decoded)),
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

    async def read(
        self,
        selector: str | NotebookCell | DatasetInfo,
        *,
        name: str | None = None,
        path: Sequence[str | int] = (),
        format: ReadFormat = "arrow",
        columns: Sequence[str] | None = None,
        offset: int = 0,
        limit: int | None = None,
        timeout: float | None = 30,
    ) -> NotebookRead:
        """Read an evaluated value, using Arrow IPC for tabular data by default.

        Strings select variable names. Cell handles select one cell's output,
        with ``name`` resolving cells that expose several variables. Dataset
        descriptors require the same view generation and value revision.
        ``path`` traverses a nested value before projection and conversion.
        """

        if format not in {"arrow", "rows", "json", "bytes"}:
            raise ValueError("format must be arrow, rows, json, or bytes")
        if (
            isinstance(path, str | bytes)
            or not isinstance(path, Sequence)
            or any(
                not isinstance(item, str | int) or isinstance(item, bool)
                for item in path
            )
        ):
            raise TypeError("path must be a sequence of string or integer keys")
        if name is not None and (not isinstance(name, str) or not name):
            raise ValueError("name must be a non-empty string")
        if columns is not None and (
            isinstance(columns, str | bytes)
            or not isinstance(columns, Sequence)
            or any(not isinstance(column, str) for column in columns)
        ):
            raise TypeError("columns must be a sequence of column names")
        if (
            type(offset) is not int
            or offset < 0
            or (limit is not None and (type(limit) is not int or limit < 0))
        ):
            raise ValueError("offset and limit must be non-negative integers")
        options: dict[str, object] = {"format": format, "offset": offset}
        if columns is not None:
            options["columns"] = list(columns)
        if limit is not None:
            options["limit"] = limit
        selected: dict[str, object]
        if isinstance(selector, DatasetInfo):
            if selector._owner is not self._requests.identity:
                raise ValueError("DatasetInfo belongs to another NotebookView")
            if selector.generation != self._requests.generation:
                raise errors.StaleViewError(
                    "DatasetInfo belongs to an expired notebook runtime"
                )
            if name is not None:
                raise ValueError("DatasetInfo already identifies a variable")
            selected = {"cell": selector.cell.index}
            if selector.name is not None:
                selected["name"] = selector.name
            options["revision"] = selector.revision
        elif isinstance(selector, NotebookCell):
            if selector._owner is not self._owner:
                raise ValueError("NotebookCell belongs to another Notebook")
            selected = {"cell": selector.index}
            if name is not None:
                selected["name"] = name
        elif isinstance(selector, str) and selector:
            if name is not None:
                raise ValueError("A string selector already identifies a variable")
            selected = {"name": selector}
        else:
            raise TypeError(
                "selector must be a variable name, NotebookCell, or DatasetInfo"
            )
        if path:
            selected["path"] = list(path)
        reply = await self._requests.request(
            {"selector": selected, "options": options}, timeout
        )
        try:
            return decode_read(reply.result, self._owner, reply.buffers)
        except (TypeError, ValueError) as cause:
            raise self._protocol_failure(cause, "read response") from cause

    async def read_attachment(self, name: str, *, timeout: float | None = 30) -> bytes:
        """Fetch one named attachment in the browser and return its exact bytes."""

        if not isinstance(name, str) or not name:
            raise ValueError("attachment name must be a non-empty string")
        reply = await self._requests.request(
            {"selector": {"attachment": name}, "options": {"format": "bytes"}},
            timeout,
        )
        try:
            result = decode_read(reply.result, self._owner, reply.buffers)
            if result.format != "bytes" or not isinstance(result.data, bytes):
                raise ValueError("Attachment response must contain bytes")
        except (TypeError, ValueError) as cause:
            raise self._protocol_failure(cause, "attachment response") from cause
        return result.data

    def close(self) -> None:
        """Close this display model."""

        if getattr(self, "_view_closed", False):
            return
        self._view_closed = True
        requests = getattr(self, "_requests", None)
        if requests is not None:
            requests.close()
        self.set_trait("_inspection", {})
        self.set_trait("_datasets", {})
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


def _metadata_wire(value: object, payload: str) -> dict[str, object]:
    if not isinstance(value, Mapping):
        raise traitlets.TraitError("Notebook metadata must be a mapping")
    if not value:
        return {}
    generation = value.get("generation")
    if (
        set(value) != {"generation", payload}
        or not isinstance(generation, str)
        or not generation
    ):
        raise traitlets.TraitError("Notebook metadata has an invalid envelope")
    contents = value.get(payload)
    if payload == "values" and not isinstance(contents, list | tuple):
        raise traitlets.TraitError("Dataset metadata must contain a list")
    return {"generation": generation, payload: contents}


def _captured_diagnostics(state: ViewState) -> tuple[errors.Diagnostic, ...]:
    diagnostics = []
    for result in state.results:
        cell = result.cell
        for error in result.errors:
            diagnostics.append(
                errors.Diagnostic(
                    name=error.name,
                    message=error.message,
                    origin=error.origin
                    or (
                        "notebook"
                        if error.phase in {"analysis", "evaluation"}
                        else "runtime"
                    ),
                    phase=error.phase,
                    component=error.component
                    or "packages/pyobservablejs/src/observablejs/_readback.py",
                    operation=error.operation or "capture cell error",
                    stack=error.stack,
                    cause=error.cause,
                    variable=error.variable,
                    cell=error.cell
                    or errors.DiagnosticCell(
                        cell.index, cell.id, cell.key or "", cell.mode, cell.source
                    ),
                )
            )
    for error in state.errors:
        diagnostics.append(
            errors.Diagnostic(
                name=error.name,
                message=error.message,
                origin=error.origin or "runtime",
                phase=error.phase,
                component=error.component
                or "packages/pyobservablejs/src/observablejs/_readback.py",
                operation=error.operation or "capture view error",
                stack=error.stack,
                cause=error.cause,
                cell=error.cell,
            )
        )
    return tuple(diagnostics)
