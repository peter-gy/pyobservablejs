"""Correlated custom-message requests for one browser view."""

from __future__ import annotations

import asyncio
import dataclasses
import math
import uuid
from collections.abc import Mapping, Sequence
from typing import Any, cast

from . import errors


@dataclasses.dataclass(frozen=True)
class _Reply:
    result: object
    buffers: tuple[bytes, ...]
    generation: str


class ViewRequests:
    def __init__(self, widget: Any) -> None:
        self._widget = widget
        self.identity = object()
        self.generation: str | None = None
        self._closed = False
        self._ready: set[asyncio.Future[str]] = set()
        self._pending: dict[str, tuple[str, asyncio.Future[_Reply], bool]] = {}
        widget.on_msg(self._on_message)
        widget.observe(self._on_inspection, names="_inspection")
        widget.observe(self._on_diagnostics, names="_diagnostics")
        self._on_inspection()

    async def request(
        self, params: Mapping[str, object], timeout: float | None
    ) -> _Reply:
        self._require_open()
        if timeout is not None and (
            isinstance(timeout, bool)
            or not isinstance(timeout, int | float)
            or not math.isfinite(timeout)
            or timeout <= 0
        ):
            raise ValueError("timeout must be a positive finite number or None")
        try:
            async with asyncio.timeout(timeout):
                generation = await self._wait_ready()
                self._require_open()
                if generation != self.generation:
                    raise errors.StaleViewError("Notebook runtime changed")
                request_id = uuid.uuid4().hex
                future: asyncio.Future[_Reply] = (
                    asyncio.get_running_loop().create_future()
                )
                self._pending[request_id] = (
                    generation,
                    future,
                    params.get("operation") != "ready",
                )
                try:
                    self._require_open()
                    if generation != self.generation:
                        raise errors.StaleViewError("Notebook runtime changed")
                    self._send(
                        "request",
                        id=request_id,
                        generation=generation,
                        params=dict(params),
                    )
                    reply = await future
                    if reply.generation != self.generation:
                        raise errors.StaleViewError("Notebook runtime changed")
                    return reply
                finally:
                    if self._pending.pop(request_id, None) is not None:
                        future.cancel()
                        self._send("cancel", id=request_id, generation=generation)
        except TimeoutError as cause:
            if isinstance(cause, errors.ObservableError):
                raise
            raise errors.NotebookTimeoutError("Notebook operation timed out") from cause

    async def _wait_ready(self) -> str:
        if self.generation is not None:
            return self.generation
        future: asyncio.Future[str] = asyncio.get_running_loop().create_future()
        self._ready.add(future)
        try:
            self._require_open()
            if self.generation is not None:
                return self.generation
            return await future
        finally:
            self._ready.discard(future)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self.generation = None
        self._widget.on_msg(self._on_message, remove=True)
        self._widget.unobserve(self._on_inspection, names="_inspection")
        self._widget.unobserve(self._on_diagnostics, names="_diagnostics")
        error = errors.ViewClosedError("Notebook view is closed")
        for request_id, (generation, _, _) in list(self._pending.items()):
            self._send("cancel", id=request_id, generation=generation)
        self._fail_pending(error)
        ready, self._ready = self._ready, set()
        for future in ready:
            self._complete(future, error=error)

    def _require_open(self) -> None:
        if self._closed:
            raise errors.ViewClosedError("Notebook view is closed")
        diagnostics = self._fatal_diagnostics()
        if diagnostics:
            raise errors._exception_for(diagnostics)

    def _fatal_diagnostics(self) -> tuple[errors.Diagnostic, ...]:
        current = getattr(self._widget, "_diagnostics_current", None)
        if current is None or not current():
            return ()
        return tuple(
            item for item in self._widget.diagnostics if errors._is_fatal(item)
        )

    def _on_diagnostics(self, change: object = None) -> None:
        if self._closed:
            return
        diagnostics = self._fatal_diagnostics()
        if diagnostics:
            self.fail(errors._exception_for(diagnostics))

    def fail(self, error: errors.ObservableError) -> None:
        for request_id, (generation, _, _) in list(self._pending.items()):
            self._send("cancel", id=request_id, generation=generation)
        self._fail_pending(error)
        ready, self._ready = self._ready, set()
        for future in ready:
            self._complete(future, error=error)

    def _send(self, message_type: str, **fields: object) -> None:
        self._widget.send(
            {
                "kind": "observablejs:access",
                "protocol": 1,
                "type": message_type,
                **fields,
            }
        )

    @staticmethod
    def _protocol_error(message: str) -> errors.ProtocolError:
        diagnostic = errors.Diagnostic(
            name="ProtocolError",
            message=message,
            origin="widget",
            phase="transport",
            component="packages/pyobservablejs/src/observablejs/_requests.py",
            operation="receive response",
        )
        return errors.ProtocolError(diagnostics=(diagnostic,))

    def _on_inspection(self, change: object = None) -> None:
        if self._closed:
            return
        metadata = self._widget._inspection
        generation = (
            metadata.get("generation") if isinstance(metadata, Mapping) else None
        )
        generation = generation if isinstance(generation, str) and generation else None
        previous = self.generation
        self.generation = generation
        if previous is not None and generation != previous:
            exception = (
                errors.ViewClosedError if generation is None else errors.StaleViewError
            )
            self._fail_pending(exception("Notebook runtime changed"))
        if generation is not None:
            ready, self._ready = self._ready, set()
            for future in ready:
                self._complete(future, result=generation)

    def _on_message(
        self, _widget: object, content: object, buffers: Sequence[Any]
    ) -> None:
        if (
            self._closed
            or not isinstance(content, Mapping)
            or content.get("kind") != "observablejs:access"
            or type(content.get("protocol")) is not int
            or content.get("protocol") != 1
        ):
            return
        generation = content.get("generation")
        if not isinstance(generation, str) or not generation:
            return
        if content.get("type") == "response":
            request_id = content.get("id")
            if not isinstance(request_id, str):
                return
            pending = self._pending.get(request_id)
            if (
                pending is None
                or pending[0] != generation
                or generation != self.generation
            ):
                return
            pending = self._pending.pop(request_id, None)
            if pending is None:
                return
            _, future, reading = pending
            error = content.get("error")
            if error is not None:
                try:
                    diagnostic = errors._diagnostic_from_wire(error)
                    diagnostics = (diagnostic,)
                    if "diagnostics" in content:
                        report = content.get("diagnostics")
                        if not isinstance(report, Mapping) or not report:
                            raise ValueError("Invalid diagnostic response snapshot")
                        self._widget.set_state({"_diagnostics": report})
                        records = cast(Mapping[str, Any], report)["errors"]
                        if not reading and records:
                            diagnostics = tuple(
                                errors._diagnostic_from_wire(item) for item in records
                            )
                except (TypeError, ValueError) as cause:
                    self._complete(
                        future,
                        error=self._protocol_error(
                            f"Invalid notebook error response: {cause}"
                        ),
                    )
                else:
                    self._complete(
                        future, error=errors._exception_for(diagnostics, read=reading)
                    )
            elif "result" in content and error is None:
                try:
                    if any(
                        not isinstance(buffer, bytes | bytearray | memoryview)
                        for buffer in buffers
                    ):
                        raise TypeError("Notebook response buffers must be binary")
                    reply = _Reply(
                        content.get("result"),
                        tuple(bytes(buffer) for buffer in buffers),
                        generation,
                    )
                except (TypeError, ValueError):
                    self._complete(
                        future,
                        error=self._protocol_error("Invalid notebook response buffers"),
                    )
                else:
                    self._complete(future, result=reply)
            else:
                self._complete(
                    future, error=self._protocol_error("Invalid notebook response")
                )

    def _fail_pending(self, error: Exception) -> None:
        pending, self._pending = self._pending, {}
        for _, future, _ in pending.values():
            self._complete(future, error=error)

    @staticmethod
    def _complete(
        future: asyncio.Future[Any],
        *,
        result: object = None,
        error: Exception | None = None,
    ) -> None:
        def complete() -> None:
            if not future.done():
                if error is None:
                    future.set_result(result)
                else:
                    future.set_exception(error)

        if not future.get_loop().is_closed():
            future.get_loop().call_soon_threadsafe(complete)
