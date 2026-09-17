"""Session-scoped source requests for browser-resolved notebook imports."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import Any

from ._observable_fetch import fetch_observablehq_document, resolve_observablehq_url
from ._observable_model import notebook_model_from_observablehq_document


class NotebookImports:
    def __init__(self, session: Any) -> None:
        self._session = session
        self._closed = False
        self._sources: dict[str, asyncio.Task[dict[str, Any]]] = {}
        self._requests: dict[str, asyncio.Task[None]] = {}
        session.on_msg(self._on_message)

    def _on_message(self, _widget: object, content: object, _buffers: object) -> None:
        if (
            not isinstance(content, Mapping)
            or content.get("kind") != "observablejs:import"
        ):
            return
        request_id = content.get("id")
        if not isinstance(request_id, str) or not request_id or self._closed:
            return
        if content.get("type") == "cancel":
            task = self._requests.pop(request_id, None)
            if task is not None:
                task.cancel()
            return
        if content.get("type") != "request" or request_id in self._requests:
            return
        try:
            if type(content.get("protocol")) is not int or content.get("protocol") != 1:
                raise ValueError("Notebook import protocol must be 1")
            specifier = content.get("specifier")
            if not isinstance(specifier, str):
                raise TypeError("Notebook import specifier must be a string")
            url = resolve_observablehq_url(specifier)
            task = asyncio.get_running_loop().create_task(
                self._respond(request_id, url)
            )
            self._requests[request_id] = task
        except (OSError, ValueError, TypeError, LookupError, RuntimeError) as error:
            self._send(
                request_id, error={"name": type(error).__name__, "message": str(error)}
            )

    async def _respond(self, request_id: str, url: str) -> None:
        try:
            task = self._sources.get(url)
            if task is None:
                task = asyncio.create_task(self._load(url))
                self._sources[url] = task
                task.add_done_callback(
                    lambda completed: self._source_finished(url, completed)
                )
            result = await asyncio.shield(task)
            self._send(request_id, result=result)
        except asyncio.CancelledError:
            pass
        except (OSError, ValueError, TypeError, LookupError, RuntimeError) as error:
            self._send(
                request_id, error={"name": type(error).__name__, "message": str(error)}
            )
        finally:
            self._requests.pop(request_id, None)

    def _source_finished(self, url: str, task: asyncio.Task[dict[str, Any]]) -> None:
        # Retrieve failures even when every requesting view has already closed.
        failed = task.cancelled() or task.exception() is not None
        if failed and self._sources.get(url) is task:
            del self._sources[url]

    async def _load(self, url: str) -> dict[str, Any]:
        document = await asyncio.to_thread(fetch_observablehq_document, url)
        model = notebook_model_from_observablehq_document(document)
        return {
            "source": model.source,
            "attachments": dict(model.attachments),
            "baseUrl": url,
        }

    def _send(self, request_id: str, **payload: object) -> None:
        if not self._closed:
            self._session.send(
                {
                    "kind": "observablejs:import",
                    "protocol": 1,
                    "type": "response",
                    "id": request_id,
                    **payload,
                }
            )

    def close(self) -> None:
        self._closed = True
        self._session.on_msg(self._on_message, remove=True)
        for task in [*self._requests.values(), *self._sources.values()]:
            task.cancel()
        self._requests.clear()
        self._sources.clear()
