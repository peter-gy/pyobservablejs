"""Headless notebook inspection and evaluation using the optional Deno runtime."""

from __future__ import annotations

import asyncio
import threading
import weakref
from collections.abc import AsyncGenerator, Callable, Generator, Sequence
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass
from typing import Any, Literal, Self, TypedDict, Unpack

from . import errors
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
from ._notebook import Notebook, NotebookCell
from ._observable_fetch import fetch_observablehq_document
from ._observable_model import notebook_model_from_observablehq_document
from ._readback import state_from_readback, validate_readback_wire
from ._server_process import ServerProcess, ServerReply
from .types import CellSelector, ViewState


class ExecutionOptions(TypedDict, total=False):
    engine: Literal["deno", "chromium"]
    network: bool | Sequence[str]
    resolve_notebook: Callable[[str], Notebook]
    timeout: float | None


class ReadParameters(TypedDict, total=False):
    name: str | None
    path: Sequence[str | int]
    format: ReadFormat
    columns: Sequence[str] | None
    offset: int
    limit: int | None
    timeout: float | None


@dataclass(frozen=True)
class _ExecutionSnapshot:
    revision: int
    generation: str
    state: ViewState
    inspection: NotebookInspection
    datasets: tuple[DatasetInfo, ...]
    diagnostics: tuple[errors.Diagnostic, ...]


class Evaluation:
    """One private execution resource with an atomically replaced snapshot.

    Reads and checkpoints apply current controller bindings before requesting
    values. Network access is enabled unless explicitly restricted.
    """

    _snapshot: _ExecutionSnapshot

    def __init__(
        self,
        notebook: Notebook,
        selectors: Sequence[CellSelector] = (),
        *,
        engine: Literal["deno", "chromium"] = "deno",
        scale: float = 1.0,
        network: bool | Sequence[str] = True,
        resolve_notebook: Callable[[str], Notebook] | None = None,
        timeout: float | None = 30,
    ) -> None:
        if engine not in {"deno", "chromium"}:
            raise ValueError("engine must be deno or chromium")
        self._engine: Literal["deno", "chromium"] = engine
        controller = notebook._controller
        controller._require_open()
        self._notebook = notebook
        self._indexes = (
            tuple(notebook._normalize_view_cells(selectors))
            if selectors
            else tuple(range(len(notebook.cells)))
        )
        self._identity = object()
        self._closed = False
        self._opened = False
        self._sync_lock = threading.Lock()
        self._sequence = controller._variable_update_seq
        self._variable_wire = controller._variables
        self._spec = controller._spec
        self._snapshot_lock = threading.Lock()
        self._timeout = timeout
        self._network = network
        self._resolve_notebook = resolve_notebook
        self._process = ServerProcess(
            engine=engine, scale=scale, network=network, source=self._resolve_source
        )
        self._finalizer = weakref.finalize(self, self._process.close)
        controller._resources.add(self)

    def open(self) -> Self:
        """Prepare the engine after its owner has acquired the closeable resource."""
        with self._sync_lock:
            if self._closed:
                raise errors.ViewClosedError("Notebook execution is closed")
            if self._opened:
                return self
            controller = self._notebook._controller
            try:
                controller._require_open()
                if self._spec is not controller._spec:
                    raise errors.StaleViewError("Notebook definition changed")
                self._sequence = controller._variable_update_seq
                self._variable_wire = controller._variables
                self._accept(
                    self._request(
                        "open",
                        timeout=self._timeout,
                        source=controller._source or controller._spec,
                        options={
                            "keys": controller._cell_keys,
                            "selection": self._indexes,
                            "variables": self._variable_wire,
                            "attachments": controller._attachments,
                            "baseUrl": controller._base_url,
                        },
                    )
                )
                self._opened = True
                return self
            except BaseException:
                self.close()
                raise

    @property
    def state(self) -> ViewState:
        return self._snapshot.state

    @property
    def inspection(self) -> NotebookInspection:
        return self._snapshot.inspection

    @property
    def datasets(self) -> tuple[DatasetInfo, ...]:
        return self._snapshot.datasets

    @property
    def diagnostics(self) -> tuple[errors.Diagnostic, ...]:
        return self._snapshot.diagnostics

    def _sync_variables(self, timeout: float | None) -> None:
        with self._transport_guard(), self._sync_lock:
            controller = self._notebook._controller
            controller._require_open()
            if self._spec is not controller._spec:
                raise errors.StaleViewError("Notebook definition changed")
            sequence = controller._variable_update_seq
            wire = controller._variables
            if sequence == self._sequence and wire is self._variable_wire:
                return
            update = controller._variable_update
            if sequence == self._sequence + 1 and update.get("kind") == "set":
                operation, values = "update", update["values"]
            else:
                operation, values = "replace", wire
            self._accept(
                self._process.request(operation, timeout=timeout, variables=values)
            )
            self._sequence, self._variable_wire = sequence, wire

    def ready(self, *, timeout: float | None = 30) -> ViewState:
        """Wait for current evaluation to settle; raise structured notebook errors."""
        self._accept(self._request("ready", timeout=timeout))
        if self.diagnostics:
            raise errors._exception_for(self.diagnostics)
        if (
            self.state.pending
            or self.state.input_revision != self.state.settled_revision
        ):
            raise errors.StaleViewError(
                "Notebook changed after the readiness checkpoint"
            )
        return self.state

    def discover(self, *, timeout: float | None = 30) -> None:
        self._accept(
            self._request(
                "discover",
                timeout=timeout,
                deadline=timeout * 900 if timeout is not None else None,
            )
        )

    def _prepare_read(
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
    ) -> dict[str, object]:
        # Generation validation follows binding synchronization for every read path.
        self._sync_variables(timeout)
        return read_parameters(
            self._notebook,
            self._identity,
            self._snapshot.generation,
            selector,
            name=name,
            path=path,
            format=format,
            columns=columns,
            offset=offset,
            limit=limit,
        )

    def _read_value(
        self,
        operation: str,
        selector: str | NotebookCell | DatasetInfo,
        **options: Unpack[ReadParameters],
    ) -> ServerReply:
        parameters = self._prepare_read(selector, **options)
        with self._transport_guard():
            reply = self._process.request(
                operation, timeout=options.get("timeout", 30), **parameters
            )
            self._check_reply(reply)
            return reply

    async def _read_value_async(
        self,
        operation: str,
        selector: str | NotebookCell | DatasetInfo,
        **options: Unpack[ReadParameters],
    ) -> ServerReply:
        async with self._async_transport_guard():
            parameters = await asyncio.to_thread(
                self._prepare_read, selector, **options
            )
            return await self._send_async(
                operation, timeout=options.get("timeout", 30), **parameters
            )

    def read(
        self,
        selector: str | NotebookCell | DatasetInfo,
        **options: Unpack[ReadParameters],
    ) -> ReadResult:
        reply = self._read_value("read", selector, **options)
        return self._decode_read(reply)

    async def read_async(
        self,
        selector: str | NotebookCell | DatasetInfo,
        **options: Unpack[ReadParameters],
    ) -> ReadResult:
        reply = await self._read_value_async("read", selector, **options)
        return self._decode_read(reply)

    def _decode_read(self, reply: ServerReply) -> ReadResult:
        with self._transport_guard():
            return decode_read(reply.message["result"], self._notebook, reply.buffers)

    def describe(
        self,
        selector: str | NotebookCell | DatasetInfo,
        **options: Unpack[ReadParameters],
    ) -> object:
        return self._read_value("describe", selector, **options).message["result"]

    async def describe_async(
        self,
        selector: str | NotebookCell | DatasetInfo,
        **options: Unpack[ReadParameters],
    ) -> object:
        reply = await self._read_value_async("describe", selector, **options)
        return reply.message["result"]

    def screenshot(self, *, timeout: float | None = 30) -> bytes:
        """Capture the rendered notebook as PNG. Requires engine='chromium'."""
        if self._engine != "chromium":
            raise ValueError("screenshot requires engine='chromium'")
        reply = self._request("screenshot", timeout=timeout)
        self._check_reply(reply)
        result = self._decode_read(reply)
        if not isinstance(result.data, bytes):
            raise errors.ProtocolError("Screenshot response must contain bytes")
        return result.data

    @contextmanager
    def _transport_guard(self) -> Generator[None]:
        try:
            yield
        except (
            errors.NotebookTimeoutError,
            errors.ProtocolError,
            errors.ViewClosedError,
        ):
            self.close()
            raise

    def _request(self, operation: str, **params: Any) -> ServerReply:
        with self._transport_guard():
            if operation != "open":
                self._sync_variables(params.get("timeout", self._timeout))
            return self._process.request(operation, **params)

    @asynccontextmanager
    async def _async_transport_guard(self) -> AsyncGenerator[None]:
        try:
            yield
        except (
            asyncio.CancelledError,
            errors.NotebookTimeoutError,
            errors.ProtocolError,
            errors.ViewClosedError,
        ):
            await asyncio.to_thread(self.close)
            raise

    async def request_async(
        self, operation: str, *, timeout: float | None = 30, **params: object
    ) -> ServerReply:
        async with self._async_transport_guard():
            await asyncio.to_thread(self._sync_variables, timeout)
            return await self._send_async(operation, timeout=timeout, **params)

    async def _send_async(
        self, operation: str, *, timeout: float | None = 30, **params: object
    ) -> ServerReply:
        reply = await self._process.request_async(operation, timeout=timeout, **params)
        self._check_reply(reply)
        return reply

    def _accept(self, reply: ServerReply) -> None:
        with self._transport_guard():
            self._check_reply(reply)
            self._accept_snapshot(reply.message["result"])

    def _accept_snapshot(self, value: Any) -> None:
        if (
            not isinstance(value, dict)
            or not {"generation", "state", "datasets", "diagnostics"} <= set(value)
            or set(value)
            - {"generation", "state", "inspection", "datasets", "diagnostics"}
            or not isinstance(value["generation"], str)
        ):
            raise errors.ProtocolError("Invalid server snapshot")
        state = state_from_readback(
            self._notebook,
            self._indexes,
            validate_readback_wire(value["state"], self._indexes),
        )
        inspection = (
            decode_inspection(value["inspection"], self._notebook)
            if "inspection" in value
            else self.inspection
        )
        datasets = decode_datasets(
            value["datasets"], self._notebook, value["generation"], self._identity
        )
        diagnostics = tuple(
            errors._diagnostic_from_wire(item) for item in value["diagnostics"]
        )
        snapshot = _ExecutionSnapshot(
            value["state"]["revision"],
            value["generation"],
            state,
            inspection,
            datasets,
            diagnostics,
        )
        with self._snapshot_lock:
            previous = getattr(self, "_snapshot", None)
            if previous is None or snapshot.revision > previous.revision:
                self._snapshot = snapshot

    def _check_reply(self, reply: ServerReply) -> None:
        if "error" in reply.message:
            if "snapshot" in reply.message:
                self._accept_snapshot(reply.message["snapshot"])
            diagnostics = tuple(
                errors._diagnostic_from_wire(item) for item in reply.message["error"]
            )
            raise errors._exception_for(diagnostics)
        if "result" not in reply.message:
            raise errors.ProtocolError("Notebook response has no result")

    def _resolve_source(self, specifier: str) -> dict[str, Any]:
        if self._resolve_notebook is not None:
            controller = self._resolve_notebook(specifier)._controller
            controller._require_open()
            return {
                "source": controller._source or controller._spec,
                "attachments": controller._attachments,
                "baseUrl": controller._base_url,
            }
        if self._network is not True:
            raise PermissionError(
                f"Notebook import {specifier!r} needs resolve_notebook or network=True"
            )
        model = notebook_model_from_observablehq_document(
            fetch_observablehq_document(specifier, timeout=self._timeout)
        )
        return {
            "source": model.source,
            "attachments": dict(model.attachments),
            "baseUrl": "https://observablehq.com/",
        }

    def close(self) -> None:
        """Stop Deno and release all pending reads and reactive resources."""
        if self._closed:
            return
        self._closed = True
        self._notebook._controller._resources.discard(self)
        self._finalizer()

    def __enter__(self) -> Self:
        return self.open()

    def __exit__(self, *_exc: object) -> None:
        self.close()


def _inspection_parameters(notebook: Notebook) -> dict[str, object]:
    controller = notebook._controller
    controller._require_open()
    return {
        "source": controller._source or controller._spec,
        "options": {
            "keys": controller._cell_keys,
            "attachments": controller._attachments,
        },
    }


def _inspection_source(specifier: str) -> dict[str, Any]:
    raise RuntimeError(f"Static inspection cannot fetch {specifier}")


def _inspection_result(reply: ServerReply, notebook: Notebook) -> NotebookInspection:
    if "error" in reply.message:
        raise errors._exception_for(
            tuple(errors._diagnostic_from_wire(item) for item in reply.message["error"])
        )
    if "result" not in reply.message:
        raise errors.ProtocolError("Notebook inspection response has no result")
    return decode_inspection(reply.message["result"], notebook)


def inspect_definition(
    notebook: Notebook, *, timeout: float | None = 30
) -> NotebookInspection:
    """Analyze source with Notebook Kit without executing any cell."""
    parameters = _inspection_parameters(notebook)
    process = ServerProcess(network=False, source=_inspection_source)
    try:
        reply = process.request("inspect", timeout=timeout, **parameters)
        return _inspection_result(reply, notebook)
    finally:
        process.close()


async def inspect_definition_async(
    notebook: Notebook, *, timeout: float | None = 30
) -> NotebookInspection:
    """Own inspection startup and transport through asynchronous cancellation."""
    parameters = _inspection_parameters(notebook)
    process = ServerProcess(network=False, source=_inspection_source)
    try:
        reply = await process.request_async("inspect", timeout=timeout, **parameters)
        return _inspection_result(reply, notebook)
    finally:
        await asyncio.to_thread(process.close)
