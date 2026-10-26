"""Chromium engine host driven through Playwright on a private event loop thread."""

from __future__ import annotations

import asyncio
import concurrent.futures
import json
import pathlib
import struct
import subprocess
import sys
import threading
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit

from . import errors
from ._host import EngineHost, Network, SourceResolver, encode_request

if TYPE_CHECKING:
    from playwright.async_api import (
        BrowserContext,
        Page,
        Playwright,
        Route,
        WebSocketRoute,
    )

_ORIGIN = "https://observablejs.invalid"
_DEFAULT_PORTS = {"http": 80, "https": 443, "ws": 80, "wss": 443}
_MODULE = f"{_ORIGIN}/chromium/browser.js"
_ASSETS = pathlib.Path(__file__).parent / "static" / "chromium"
_RECEIVE = """async ({ module, request }) => {
    const api = await import(module);
    api.receive(JSON.parse(request));
}"""


def decode_frame(frame: bytes) -> tuple[dict[str, Any], tuple[bytes, ...]]:
    """Split a browser response into its JSON header and binary buffers."""
    if len(frame) < 4:
        raise errors.ProtocolError("Invalid notebook frame size")
    (size,) = struct.unpack_from(">I", frame)
    if size > len(frame) - 4:
        raise errors.ProtocolError("Truncated notebook frame")
    header = json.loads(frame[4 : size + 4])
    if not isinstance(header, dict):
        raise errors.ProtocolError("Invalid notebook frame header")
    sizes = header.pop("buffers", None)
    if not isinstance(sizes, list) or any(
        type(length) is not int or length < 0 for length in sizes
    ):
        raise errors.ProtocolError("Invalid notebook frame header")
    buffers = []
    offset = size + 4
    for length in sizes:
        if offset + length > len(frame):
            raise errors.ProtocolError("Invalid notebook buffer size")
        buffers.append(frame[offset : offset + length])
        offset += length
    if offset != len(frame):
        raise errors.ProtocolError("Unexpected trailing notebook bytes")
    return header, tuple(buffers)


class ChromiumEngine(EngineHost):
    """Evaluate in headless Chromium through a routed virtual origin.

    The page loads the packaged browser engine from `_ORIGIN` and posts framed
    responses back through the same route. No HTTP listener or widget model is
    involved. Notebook network policy applies to page requests and WebSockets.
    """

    def __init__(
        self, *, scale: float, network: Network, source: SourceResolver
    ) -> None:
        try:
            import playwright.async_api  # noqa: F401
        except ImportError as cause:
            raise ImportError(
                "Install pyobservablejs[chromium] to use engine='chromium'"
            ) from cause
        if not (_ASSETS / "browser.js").is_file():
            raise FileNotFoundError(f"Packaged Chromium assets are missing: {_ASSETS}")
        super().__init__(source=source, startup_timeout=180)
        self._network = network
        self._commands: asyncio.Queue[Mapping[str, object] | None] = asyncio.Queue()
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(
            target=self._loop.run_forever, name="observablejs-chromium", daemon=True
        )
        self._thread.start()
        self._task = asyncio.run_coroutine_threadsafe(self._run(scale), self._loop)
        self._task.add_done_callback(self._finished)

    def _allowed(self, url: str) -> bool:
        if self._network is True:
            return True
        if self._network is False:
            return False
        parts = urlsplit(url)
        host = parts.hostname or ""
        port = parts.port or _DEFAULT_PORTS.get(parts.scheme)
        return any(allowed in {host, f"{host}:{port}"} for allowed in self._network)

    def _send(self, message: Mapping[str, object]) -> None:
        if self._closed or self._loop.is_closed():
            raise errors.ViewClosedError("Notebook engine is closed")
        encode_request(message)
        self._loop.call_soon_threadsafe(self._commands.put_nowait, message)

    async def _run(self, scale: float) -> None:
        from playwright.async_api import async_playwright

        async with async_playwright() as playwright:
            await _install_chromium(playwright)
            browser = await playwright.chromium.launch(
                headless=True, channel="chromium"
            )
            try:
                context = await browser.new_context(
                    viewport={"width": 640, "height": 480},
                    device_scale_factor=scale,
                    service_workers="block",
                    # Request routes still enforce the selected host policy for private networks.
                    permissions=["local-network-access"],
                )
                await context.route("**/*", self._route)
                await context.route_web_socket("**/*", self._route_web_socket)
                page = await context.new_page()
                await page.goto(_ORIGIN)
                await page.evaluate("async (url) => { await import(url); }", _MODULE)
                self._deliver({"type": "ready", "protocol": 1}, ())
                await self._serve(page, context)
            finally:
                await browser.close()

    async def _serve(self, page: Page, context: BrowserContext) -> None:
        while (message := await self._commands.get()) is not None:
            if message.get("operation") == "screenshot":
                png = await page.screenshot(full_page=True, animations="disabled")
                self._deliver(
                    {
                        "type": "response",
                        "id": message["id"],
                        "result": {
                            "cell": None,
                            "name": None,
                            "revision": 0,
                            "format": "bytes",
                            "binary": True,
                            "mimeType": "image/png",
                        },
                    },
                    (png,),
                )
                continue
            await page.evaluate(
                _RECEIVE, {"module": _MODULE, "request": json.dumps(message)}
            )

    async def _route(self, route: Route) -> None:
        request = route.request
        url = urlsplit(request.url)
        if f"{url.scheme}://{url.netloc}" != _ORIGIN:
            if self._allowed(request.url):
                await route.continue_()
            else:
                await route.abort("accessdenied")
            return
        if url.path == "/response" and request.method == "POST":
            await route.fulfill(status=204)
            try:
                frame = request.post_data_buffer
                if frame is None:
                    raise errors.ProtocolError("Browser response has no frame")
                self._deliver(*decode_frame(frame))
            except ValueError as cause:
                self._stop(
                    errors.ProtocolError(f"Invalid Chromium engine message: {cause}")
                )
            return
        if url.path == "/":
            await route.fulfill(
                content_type="text/html",
                body='<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>',
            )
            return
        asset = (_ASSETS / url.path.removeprefix("/chromium/")).resolve()
        if (
            not url.path.startswith("/chromium/")
            or not asset.is_relative_to(_ASSETS.resolve())
            or not asset.is_file()
        ):
            await route.fulfill(status=404)
            return
        await route.fulfill(
            body=asset.read_bytes(),
            content_type="text/css" if asset.suffix == ".css" else "text/javascript",
        )

    async def _route_web_socket(self, route: WebSocketRoute) -> None:
        if self._allowed(route.url):
            route.connect_to_server()
        else:
            await route.close(code=1008, reason="Notebook network access denied")

    def _finished(self, task: concurrent.futures.Future[None]) -> None:
        if self._closed:
            return
        failure = None if task.cancelled() else task.exception()
        self._stop(
            errors.EngineError(f"Chromium engine stopped: {failure}")
            if failure is not None
            else errors.ViewClosedError("Notebook engine is closed")
        )

    def _stop(self, failure: Exception) -> None:
        self._fail(failure)
        # Shutdown waits on the browser task, so it runs off the event loop thread.
        threading.Thread(
            target=self.close, name="observablejs-chromium-close", daemon=True
        ).start()

    def _shutdown(self) -> None:
        if self._loop.is_closed():
            return
        self._loop.call_soon_threadsafe(self._commands.put_nowait, None)
        # Browser teardown reports its own failures through `_finished`.
        _, pending = concurrent.futures.wait([self._task], timeout=10)
        if pending:
            self._loop.call_soon_threadsafe(self._task.cancel)
        self._loop.call_soon_threadsafe(self._loop.stop)
        if self._thread is not threading.current_thread():
            self._thread.join(timeout=5)
            self._loop.close()


async def _install_chromium(playwright: Playwright) -> None:
    """Install the version-pinned Chromium build the first time the engine runs."""
    if pathlib.Path(playwright.chromium.executable_path).exists():
        return
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "playwright",
        "install",
        "chromium",
        "--no-shell",
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    _, stderr = await process.communicate()
    if process.returncode:
        raise errors.EngineError(
            f"Chromium installation failed: {stderr.decode(errors='replace').strip()}"
        )
