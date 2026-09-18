"""Framed, full-duplex transport to the packaged Deno evaluator."""

from __future__ import annotations

import asyncio
import concurrent.futures
import inspect
import json
import math
import pathlib
import queue
import struct
import subprocess
import threading
import uuid
import weakref
from collections import deque
from collections.abc import Callable, Generator, Mapping, Sequence
from contextlib import contextmanager, suppress
from dataclasses import dataclass
from typing import IO, Any, Literal

from . import errors

_MAX_FRAME = 64 * 1024 * 1024


@dataclass(frozen=True)
class ServerReply:
    message: Mapping[str, Any]
    buffers: tuple[bytes, ...]


class ServerProcess:
    def __init__(
        self,
        *,
        engine: Literal["deno", "chromium"] = "deno",
        network: bool | Sequence[str],
        source: Callable[[str], dict[str, Any]],
    ) -> None:
        try:
            from deno import find_deno_bin
        except ImportError as cause:
            raise ImportError(
                "Install pyobservablejs[server] to use headless evaluation"
            ) from cause
        script = pathlib.Path(__file__).parent / "static" / "server" / "server.js"
        if not script.is_file():
            raise FileNotFoundError(f"Packaged server bundle is missing: {script}")
        args = [
            find_deno_bin(),
            "run",
            "--no-config",
            "--location=https://observablehq.com/",
            "--no-npm",
            "--unstable-lazy-dynamic-imports",
            "--no-lock",
            "--no-prompt",
            "--quiet",
        ]
        if not isinstance(network, bool) and (
            isinstance(network, str | bytes)
            or not isinstance(network, Sequence)
            or any(
                not isinstance(host, str) or not host or "," in host for host in network
            )
        ):
            raise TypeError("network must be a boolean or a sequence of host names")
        if engine == "chromium":
            args.extend(["--allow-all", "--unstable-detect-cjs"])
        elif network is True:
            args.extend(["--allow-net", "--allow-import"])
        elif network is not False:
            if network:
                hosts = ",".join(network)
                args.extend([f"--allow-net={hosts}", f"--allow-import={hosts}"])
            else:
                args.append("--deny-import")
        else:
            args.append("--deny-import")
        if engine == "deno":
            args.append(f"--allow-read={script.parent}")
        args.extend([str(script), engine, json.dumps(network)])
        self._source: Callable[[str], dict[str, Any]]
        if inspect.ismethod(source):
            reference: weakref.WeakMethod[Callable[[str], dict[str, Any]]] = (
                weakref.WeakMethod(source)
            )

            def resolve_source(specifier: str) -> dict[str, Any]:
                callback = reference()
                if callback is None:
                    raise errors.ViewClosedError("Notebook execution is closed")
                return callback(specifier)

            self._source = resolve_source
        else:
            self._source = source
        self._lock = threading.RLock()
        self._outgoing: queue.SimpleQueue[bytes | None] = queue.SimpleQueue()
        self._pending: dict[str, concurrent.futures.Future[ServerReply]] = {}
        self._closed = False
        self._startup_timeout = 180 if engine == "chromium" else 30
        self._ready: concurrent.futures.Future[None] = concurrent.futures.Future()
        self._ready.set_running_or_notify_cancel()
        self._stderr: deque[str] = deque(maxlen=32)
        self._process = subprocess.Popen(
            args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE
        )
        self._reader = threading.Thread(
            target=self._read, name="observablejs-server", daemon=True
        )
        self._errors = threading.Thread(
            target=self._read_errors, name="observablejs-stderr", daemon=True
        )
        self._writer = threading.Thread(
            target=self._write, name="observablejs-stdin", daemon=True
        )
        self._writer.start()
        self._reader.start()
        self._errors.start()

    def request(
        self, operation: str, *, timeout: float | None = 30, **params: object
    ) -> ServerReply:
        _validate_timeout(timeout)
        self._wait_ready()
        try:
            with self._pending_request(operation, params) as future:
                return future.result(timeout)
        except concurrent.futures.TimeoutError as cause:
            # A synchronous loop cannot process cancellation; terminating the
            # isolated process bounds CPU use as well as Python's wait.
            self.close()
            raise errors.NotebookTimeoutError(
                f"Notebook server {operation} timed out; the server was closed"
            ) from cause

    async def request_async(
        self, operation: str, *, timeout: float | None = 30, **params: object
    ) -> ServerReply:
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
                f"Notebook server {operation} timed out; the server was closed"
            ) from cause

    @contextmanager
    def _pending_request(
        self, operation: str, params: Mapping[str, object]
    ) -> Generator[concurrent.futures.Future[ServerReply]]:
        request_id = uuid.uuid4().hex
        future: concurrent.futures.Future[ServerReply] = concurrent.futures.Future()
        future.set_running_or_notify_cancel()
        with self._lock:
            if self._closed:
                raise errors.ViewClosedError("Notebook server is closed")
            self._pending[request_id] = future
        try:
            self._send(
                {"type": "request", "id": request_id, "operation": operation, **params}
            )
            yield future
        except (errors.ObservableError, TimeoutError):
            raise
        except (OSError, ValueError) as cause:
            self.close()
            raise errors.ProtocolError("Notebook server transport failed") from cause
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

    def _send(self, message: Mapping[str, object]) -> None:
        payload = json.dumps(message, allow_nan=False, separators=(",", ":")).encode()
        if len(payload) > _MAX_FRAME:
            raise ValueError("Notebook request exceeds the transport limit")
        with self._lock:
            if self._closed:
                raise errors.ViewClosedError("Notebook server is closed")
            self._outgoing.put(struct.pack(">I", len(payload)) + payload)

    def _write(self) -> None:
        stream = self._process.stdin
        assert stream is not None
        try:
            while (frame := self._outgoing.get()) is not None:
                stream.write(frame)
                stream.flush()
        except OSError as cause:
            if not self._closed:
                self._fail(
                    errors.ProtocolError(f"Notebook server input failed: {cause}")
                )
        finally:
            with suppress(OSError):
                stream.close()

    def _read(self) -> None:
        stream = self._process.stdout
        assert stream is not None
        try:
            while not self._closed:
                length = struct.unpack(">I", _read_exact(stream, 4))[0]
                if length > _MAX_FRAME:
                    raise ValueError("Notebook response exceeds the transport limit")
                message = json.loads(_read_exact(stream, length))
                if not isinstance(message, dict) or not isinstance(
                    message.get("buffers"), list
                ):
                    raise TypeError("Invalid notebook response envelope")
                sizes = message["buffers"]
                if (
                    any(type(size) is not int or size < 0 for size in sizes)
                    or sum(sizes) > _MAX_FRAME
                ):
                    raise ValueError("Invalid notebook response buffers")
                buffers = tuple(_read_exact(stream, size) for size in sizes)
                if message.get("type") == "ready":
                    with self._lock:
                        if self._closed:
                            return
                        if (
                            self._ready.done()
                            or message.get("protocol") != 1
                            or buffers
                        ):
                            raise ValueError("Invalid engine startup acknowledgment")
                        self._ready.set_result(None)
                    continue
                if message.get("type") == "source":
                    threading.Thread(
                        target=self._resolve_source, args=(message,), daemon=True
                    ).start()
                    continue
                if message.get("type") != "response" or not isinstance(
                    message.get("id"), str
                ):
                    raise ValueError("Invalid notebook response identity")
                with self._lock:
                    future = self._pending.pop(message["id"], None)
                    if future is not None and not future.done():
                        future.set_result(ServerReply(message, buffers))
        except (OSError, ValueError, TypeError, EOFError) as cause:
            if not self._closed:
                details = "".join(self._stderr).strip()
                self._fail(
                    errors.ProtocolError(
                        f"Notebook server stopped: {details or str(cause)}"
                    )
                )
                self.close()

    def _read_errors(self) -> None:
        stream = self._process.stderr
        assert stream is not None
        while chunk := stream.read(4096):
            self._stderr.append(chunk.decode(errors="replace"))

    def _resolve_source(self, message: Mapping[str, Any]) -> None:
        try:
            result = self._source(str(message["specifier"]))
            self._send({"type": "source", "id": message["id"], "result": result})
        except errors.ViewClosedError:
            return
        except (OSError, ValueError, TypeError, LookupError, RuntimeError) as cause:
            # Resolver callbacks and their serialization are an external boundary;
            # report their failures through the correlated import request.
            with suppress(errors.ViewClosedError):
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
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(failure)
            self._pending.clear()

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            self._fail(errors.ViewClosedError("Notebook server is closed"))
        self._outgoing.put(None)
        process = self._process
        if process.poll() is None:
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
        for thread in (self._writer, self._reader, self._errors):
            if thread is not threading.current_thread():
                thread.join(timeout=2)
        for stream in (process.stdin, process.stdout, process.stderr):
            if stream is not None:
                with suppress(OSError):
                    stream.close()


def _read_exact(stream: IO[bytes], length: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < length:
        chunk = stream.read(length - len(chunks))
        if not chunk:
            raise EOFError("Unexpected end of notebook server stream")
        chunks.extend(chunk)
    return bytes(chunks)


def _validate_timeout(timeout: float | None) -> None:
    if timeout is not None and (
        isinstance(timeout, bool)
        or not isinstance(timeout, int | float)
        or not math.isfinite(timeout)
        or timeout <= 0
    ):
        raise ValueError("timeout must be a positive finite number or None")
