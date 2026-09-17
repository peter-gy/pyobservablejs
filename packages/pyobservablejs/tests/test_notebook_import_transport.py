from __future__ import annotations

import asyncio
import threading
from typing import Any

import observablejs as obs
from helpers import notebook_session


def test_import_requests_share_source_and_cancel_independently(monkeypatch):
    async def run():
        started = asyncio.Event()
        release = threading.Event()
        loop = asyncio.get_running_loop()
        fetched: list[str] = []

        def fetch(specifier: str, **_options: Any):
            fetched.append(specifier)
            loop.call_soon_threadsafe(started.set)
            assert release.wait(5)
            return {
                "id": "0123456789abcdef",
                "version": 3,
                "body": {
                    "stdlib": "2",
                    "cells": [
                        {"id": 0, "mode": "ts", "value": "const answer: number = 42;"}
                    ],
                },
            }

        monkeypatch.setattr("observablejs._imports.fetch_observablehq_document", fetch)
        notebook = obs.Notebook()
        session = notebook_session(notebook)
        replies: list[dict[str, Any]] = []
        received = asyncio.Event()

        def send(message, **_options):
            replies.append(message)
            received.set()

        monkeypatch.setattr(session, "send", send)
        envelope = {"kind": "observablejs:import", "protocol": 1}
        try:
            for request_id in ("cancelled", "active"):
                session._handle_custom_msg(
                    {
                        **envelope,
                        "type": "request",
                        "id": request_id,
                        "specifier": "@example/source",
                    },
                    [],
                )
            await asyncio.wait_for(started.wait(), 5)
            session._handle_custom_msg(
                {**envelope, "type": "cancel", "id": "cancelled"}, []
            )
            release.set()
            await asyncio.wait_for(received.wait(), 5)
            assert fetched == ["https://observablehq.com/@example/source"]
            assert [reply["id"] for reply in replies] == ["active"]
            source = replies[0]["result"]
            restored = obs.Notebook.from_html(source["source"])
            try:
                assert restored.cells[0].mode == "ts"
                assert restored.cells[0].source == "const answer: number = 42;"
            finally:
                restored.close()
        finally:
            release.set()
            notebook.close()

    asyncio.run(run())


def test_failed_imports_are_reported_and_can_be_retried(monkeypatch):
    async def run():
        attempts = 0

        def fetch(_specifier):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise OSError("source unavailable")
            return {"cells": [{"id": 1, "mode": "js", "value": "const x = 1;"}]}

        monkeypatch.setattr("observablejs._imports.fetch_observablehq_document", fetch)
        notebook = obs.Notebook()
        session = notebook_session(notebook)
        replies: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        monkeypatch.setattr(session, "send", replies.put_nowait)
        try:
            results = []
            for request_id in ("failed", "retry"):
                session._handle_custom_msg(
                    {
                        "kind": "observablejs:import",
                        "protocol": 1,
                        "type": "request",
                        "id": request_id,
                        "specifier": "@example/source",
                    },
                    [],
                )
                results.append(await asyncio.wait_for(replies.get(), 5))
            assert attempts == 2
            assert results[0]["error"] == {
                "name": "OSError",
                "message": "source unavailable",
            }
            assert results[1]["id"] == "retry"
            assert "const x = 1;" in results[1]["result"]["source"]
        finally:
            notebook.close()

    asyncio.run(run())
