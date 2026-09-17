"""Renderable anywidget view, correlated browser reads, and detached state."""

from __future__ import annotations

import pathlib
from collections.abc import Mapping, Sequence
from typing import TYPE_CHECKING, Any, cast

import anywidget
import traitlets
from anywidget_bundle import Bundle, BundledWidget

from . import _notebook, errors
from ._inspection import (
    DatasetInfo,
    NotebookInspection,
    ReadFormat,
    ReadResult,
    decode_datasets,
    decode_inspection,
    decode_read,
    read_parameters,
)
from ._readback import state_from_readback, validate_readback_wire
from ._requests import ViewRequests
from ._view_options import ResolvedNotebookViewOptions
from ._widget_session import _NotebookSession
from .types import ViewState

if TYPE_CHECKING:
    from ._async_data import ViewData
    from ._file_access import AsyncFiles
    from ._namespaces import Cells, ViewGraph

_WIDGET_TRAIT = anywidget.WidgetTrait()
_WIDGET_TO_JSON = _WIDGET_TRAIT.metadata["to_json"]
_WIDGET_FROM_JSON = _WIDGET_TRAIT.metadata["from_json"]
_OBSERVABLE_WIDGET_BUNDLE = Bundle(
    static_dir=pathlib.Path(__file__).parent / "static",
    dev_server_env="OBSERVABLEJS_VITE_DEV_SERVER",
)


class NotebookView(BundledWidget):
    """Renderable view with structured browser evaluation ``state``."""

    bundle = _OBSERVABLE_WIDGET_BUNDLE

    _owner: _notebook.Notebook
    _data: ViewData
    _graph: ViewGraph
    _files: AsyncFiles
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
        notebook: _notebook.Notebook,
        cell_indexes: Sequence[int] | None,
        *,
        options: ResolvedNotebookViewOptions,
    ) -> NotebookView:
        notebook._controller._require_open()
        view = cls.__new__(cls)
        view._owner = notebook
        view._owns_notebook = False
        view._view_closed = False
        indexes = None if cell_indexes is None else list(cell_indexes)
        BundledWidget.__init__(
            view,
            _session=notebook._widget_session(),
            _cell_indexes=indexes,
            _capture_state=options.capture_state,
        )
        view._requests = ViewRequests(view)
        from ._async_data import ViewData
        from ._file_access import AsyncFiles

        view._data = ViewData(view)
        view._files = AsyncFiles(notebook, view)
        from ._namespaces import ViewGraph

        view._graph = ViewGraph(view)
        view._accepted_readback = view._readback
        view.set_trait("state", view._state_from_readback(view._readback))
        notebook._controller._resources.add(view)
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
            component="packages/pyobservablejs/src/observablejs/_view.py",
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
            current["sequence"] >= self._owner._controller._variable_update_seq
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
        sequence = self._owner._controller._variable_update_seq
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
            sequence != self._owner._controller._variable_update_seq
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
            if inspection is not None:
                self._owner._analysis_cache = inspection
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
        if owner is not None and session is not owner._widget_session():
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
        return state_from_readback(self._owner, self._selected_indexes(), value)

    @property
    def notebook(self) -> _notebook.Notebook:
        """Notebook definition and session rendered by this view."""

        return self._owner

    @property
    def cells(self) -> Cells:
        from ._namespaces import Cells

        return Cells(self._owner, self._selected_indexes())

    @property
    def graph(self) -> ViewGraph:
        return self._graph

    @property
    def data(self) -> ViewData:
        return self._data

    @property
    def files(self) -> AsyncFiles:
        return self._files

    async def _read(
        self,
        selector: str | _notebook.NotebookCell | DatasetInfo,
        *,
        name: str | None = None,
        path: Sequence[str | int] = (),
        format: ReadFormat = "arrow",
        columns: Sequence[str] | None = None,
        offset: int = 0,
        limit: int | None = None,
        timeout: float | None = 30,
    ) -> ReadResult:
        """Read an evaluated value, using Arrow IPC for tabular data by default.

        Strings select variable names. Cell handles select one cell's output,
        with ``name`` resolving cells that expose several variables. Dataset
        descriptors require the same view generation and value revision.
        ``path`` traverses a nested value before projection and conversion.
        """

        params = read_parameters(
            self._owner,
            self._requests.identity,
            self._requests.generation,
            selector,
            name=name,
            path=path,
            format=format,
            columns=columns,
            offset=offset,
            limit=limit,
        )
        reply = await self._requests.request(params, timeout)
        try:
            return decode_read(reply.result, self._owner, reply.buffers)
        except (TypeError, ValueError) as cause:
            raise self._protocol_failure(cause, "read response") from cause

    async def _read_attachment(self, name: str, *, timeout: float | None = 30) -> bytes:
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
            self._owner._controller._resources.discard(self)
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
