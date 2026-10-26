"""Correlated requests to a notebook engine: the embedded V8 isolate or Chromium."""

from __future__ import annotations

import asyncio
import concurrent.futures
import inspect
import itertools
import json
import math
import os
import sys
import threading
import weakref
from collections.abc import Callable, Generator, Mapping, Sequence
from contextlib import contextmanager, suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from . import errors

_MAX_MESSAGE = 64 * 1024 * 1024

EngineName = Literal["embedded", "chromium"]
Network = bool | Sequence[str]
SourceResolver = Callable[[str], dict[str, Any]]


@dataclass(frozen=True)
class EngineReply:
    message: Mapping[str, Any]
    buffers: tuple[bytes, ...]


def module_cache_dir() -> Path:
    """Directory that keeps remote module source across processes."""
    if configured := os.environ.get("PYOBSERVABLEJS_CACHE_DIR"):
        return Path(configured)
    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Caches"
    elif sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    else:
        base = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache")
    return base / "pyobservablejs" / "modules"


def validate_network(network: Network) -> Network:
    """Accept `True`, `False`, or host names in lower case.

    A bare host allows every port. A `host:port` entry allows one port, and the
    scheme's default port matches URLs that omit it.
    """
    if isinstance(network, bool):
        return network
    hosts = (
        tuple(network)
        if isinstance(network, Sequence) and not isinstance(network, str | bytes)
        else None
    )
    if hosts is None or any(
        not isinstance(host, str) or not host or "," in host for host in hosts
    ):
        raise TypeError("network must be a boolean or a sequence of host names")
    return tuple(host.lower() for host in hosts)


class EngineHost:
    """Request correlation, readiness, timeouts, and notebook source callbacks.

    Transports deliver every engine message to `_deliver` and send requests
    through `_send`. A timeout or cancelled asynchronous request closes the
    engine, which bounds synchronous JavaScript loops as well as pending work.
    """

    def __init__(self, *, source: SourceResolver, startup_timeout: float) -> None:
        if inspect.ismethod(source):
            reference = weakref.WeakMethod(source)

            def resolve_source(specifier: str) -> dict[str, Any]:
                callback = reference()
                if callback is None:
                    raise errors.ViewClosedError("Notebook execution is closed")
                return callback(specifier)

            self._source: SourceResolver = resolve_source
        else:
            self._source = source
        self._lock = threading.RLock()
        self._ids = itertools.count(1)
        self._pending: dict[str, concurrent.futures.Future[EngineReply]] = {}
        self._closed = False
        self._startup_timeout = startup_timeout
        self._ready: concurrent.futures.Future[None] = concurrent.futures.Future()
        self._ready.set_running_or_notify_cancel()

    def _send(self, message: Mapping[str, object]) -> None:
        raise NotImplementedError

    def _shutdown(self) -> None:
        raise NotImplementedError

    def request(
        self, operation: str, *, timeout: float | None = 30, **params: object
    ) -> EngineReply:
        _validate_timeout(timeout)
        self._wait_ready()
        try:
            with self._pending_request(operation, params) as future:
                return future.result(timeout)
        except concurrent.futures.TimeoutError as cause:
            self.close()
            raise errors.NotebookTimeoutError(
                f"Notebook engine {operation} timed out; the engine was closed"
            ) from cause

    async def request_async(
        self, operation: str, *, timeout: float | None = 30, **params: object
    ) -> EngineReply:
        _validate_timeout(timeout)
        await asyncio.to_thread(self._wait_ready)
        try:
            with self._pending_request(operation, params) as future:
                async with asyncio.timeout(timeout):
                    return await asyncio.wrap_future(future)
        except asyncio.CancelledError:
            # Cancellation must also stop code that cannot receive an in-band message.
            await asyncio.to_thread(self.close)
            raise
        except TimeoutError as cause:
            await asyncio.to_thread(self.close)
            raise errors.NotebookTimeoutError(
                f"Notebook engine {operation} timed out; the engine was closed"
            ) from cause

    @contextmanager
    def _pending_request(
        self, operation: str, params: Mapping[str, object]
    ) -> Generator[concurrent.futures.Future[EngineReply]]:
        request_id = str(next(self._ids))
        future: concurrent.futures.Future[EngineReply] = concurrent.futures.Future()
        future.set_running_or_notify_cancel()
        with self._lock:
            if self._closed:
                raise errors.ViewClosedError("Notebook engine is closed")
            self._pending[request_id] = future
        try:
            try:
                self._send(
                    {
                        "type": "request",
                        "id": request_id,
                        "operation": operation,
                        **params,
                    }
                )
            except (TypeError, ValueError) as cause:
                raise errors.ProtocolError(
                    f"Notebook {operation} request is not JSON serializable"
                ) from cause
            yield future
        finally:
            with self._lock:
                self._pending.pop(request_id, None)

    def _wait_ready(self) -> None:
        try:
            self._ready.result(self._startup_timeout)
        except concurrent.futures.TimeoutError as cause:
            self.close()
            raise errors.NotebookTimeoutError(
                "Notebook engine preparation timed out"
            ) from cause

    def _deliver(self, message: dict[str, Any], buffers: tuple[bytes, ...]) -> None:
        if not isinstance(message, dict):
            raise errors.ProtocolError("Notebook engine message must be an object")
        kind = message.get("type")
        if kind == "ready":
            with self._lock:
                if self._ready.done() or message.get("protocol") != 1 or buffers:
                    raise errors.ProtocolError("Invalid engine startup acknowledgment")
                self._ready.set_result(None)
        elif kind == "source":
            threading.Thread(
                target=self._resolve_source,
                args=(message,),
                name="observablejs-source",
                daemon=True,
            ).start()
        elif kind == "response" and isinstance(message.get("id"), str):
            with self._lock:
                future = self._pending.pop(message["id"], None)
            if future is not None and not future.done():
                future.set_result(EngineReply(message, buffers))
        else:
            raise errors.ProtocolError("Invalid notebook engine message")

    def _resolve_source(self, message: Mapping[str, Any]) -> None:
        try:
            result = self._source(str(message["specifier"]))
            self._send({"type": "source", "id": message["id"], "result": result})
        except errors.ViewClosedError:
            return
        except (OSError, ValueError, TypeError, LookupError, RuntimeError) as cause:
            # Resolver callbacks and their serialization are an external boundary;
            # report their failures through the correlated import request.
            with suppress(errors.ViewClosedError, errors.EngineError):
                self._send(
                    {
                        "type": "source",
                        "id": message["id"],
                        "error": f"{type(cause).__name__}: {cause}",
                    }
                )

    def _fail(self, failure: Exception) -> None:
        with self._lock:
            if not self._ready.done():
                self._ready.set_exception(failure)
            pending = tuple(self._pending.values())
            self._pending.clear()
        for future in pending:
            if not future.done():
                future.set_exception(failure)

    @property
    def closed(self) -> bool:
        return self._closed

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
        self._fail(errors.ViewClosedError("Notebook engine is closed"))
        self._shutdown()


def encode_request(message: Mapping[str, object]) -> str:
    payload = json.dumps(message, allow_nan=False, separators=(",", ":"))
    if len(payload) > _MAX_MESSAGE:
        raise errors.EngineError("Notebook request exceeds the transport limit")
    return payload


class EmbeddedEngine(EngineHost):
    """Run the engine bundle in a V8 isolate inside this Python process."""

    def __init__(self, *, network: Network, source: SourceResolver) -> None:
        super().__init__(source=source, startup_timeout=30)
        try:
            from ._engine import Engine
        except ImportError as cause:
            raise ImportError(
                "Headless evaluation needs the native pyobservablejs wheel for this "
                "platform. Notebook views and NotebookView.data work with every wheel."
            ) from cause
        try:
            self._engine = Engine(network=network, cache_dir=str(module_cache_dir()))
        except (RuntimeError, MemoryError) as cause:
            raise errors.EngineError(
                f"Notebook engine failed to start: {cause}"
            ) from cause
        self._reader = threading.Thread(
            target=self._read, name="observablejs-engine-reader", daemon=True
        )
        self._reader.start()

    def _send(self, message: Mapping[str, object]) -> None:
        from ._engine import EngineStopped

        try:
            self._engine.send(encode_request(message))
        except EngineStopped as cause:
            raise errors.ViewClosedError("Notebook engine is closed") from cause
        except (RuntimeError, MemoryError) as cause:
            # Heap exhaustion races the reader thread, and handles fail after fork.
            raise errors.EngineError(str(cause)) from cause

    def _read(self) -> None:
        from ._engine import EngineStopped

        try:
            while True:
                message = self._engine.receive()
                if message is not None:
                    header, buffers = message
                    self._deliver(json.loads(header), tuple(buffers))
        except MemoryError as cause:
            self._stop(errors.EngineError(str(cause)))
        except EngineStopped as cause:
            if not self._closed:
                self._stop(errors.EngineError(f"Notebook engine stopped: {cause}"))
        except ValueError as cause:
            self._stop(
                errors.ProtocolError(f"Invalid notebook engine message: {cause}")
            )

    def _stop(self, failure: Exception) -> None:
        self._fail(failure)
        self.close()

    def _shutdown(self) -> None:
        self._engine.close()
        if self._reader is not threading.current_thread():
            self._reader.join(timeout=5)


def _validate_timeout(timeout: float | None) -> None:
    if timeout is not None and (
        isinstance(timeout, bool)
        or not isinstance(timeout, int | float)
        or not math.isfinite(timeout)
        or timeout <= 0
    ):
        raise ValueError("timeout must be a positive finite number or None")
