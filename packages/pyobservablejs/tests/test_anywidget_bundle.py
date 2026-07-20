from __future__ import annotations

import json
import pathlib
from collections.abc import Sequence
from typing import Any

import observablejs as obs
import pytest
from helpers import notebook_session


def test_private_session_loads_before_live_updates() -> None:
    notebook = obs.Notebook()

    try:
        assert notebook_session(notebook).get_state(["_esm"]) == {
            "_esm": "export default { initialize() {} };"
        }
    finally:
        notebook.close()


def test_notebook_view_serves_manifest_app_module_as_binary_buffer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    notebook = obs.Notebook()
    view = notebook.view()
    sent: list[tuple[dict[str, Any], list[bytes]]] = []

    def record_send(
        content: dict[str, Any],
        buffers: Sequence[bytes | bytearray | memoryview] | None = None,
    ) -> None:
        sent.append((content, [bytes(buffer) for buffer in buffers or []]))

    monkeypatch.setattr(view, "send", record_send)
    try:
        static_dir = view.bundle.static_dir
        manifest = json.loads(
            (static_dir / "anywidget.json").read_text(encoding="utf-8")
        )
        entry_name = manifest.get("entry")
        app_name = manifest.get("app")
        style_name = manifest.get("style")
        assert isinstance(entry_name, str)
        assert isinstance(app_name, str)
        assert isinstance(style_name, str)

        entry_path = static_dir.joinpath(*pathlib.PurePosixPath(entry_name).parts)
        app_path = static_dir.joinpath(*pathlib.PurePosixPath(app_name).parts)
        style_path = static_dir.joinpath(*pathlib.PurePosixPath(style_name).parts)
        entry_source = entry_path.read_text(encoding="utf-8")
        app_source = app_path.read_text(encoding="utf-8")

        assert view.get_state(["_esm", "_css"]) == {
            "_esm": entry_source,
            "_css": style_path.read_text(encoding="utf-8"),
        }
        assert len(entry_source.encode()) < len(app_source.encode())

        sent.clear()
        view._handle_custom_msg(
            {
                "type": "anywidget-bundle:request",
                "version": 1,
                "id": "request-1",
                "path": app_name,
            },
            [],
        )

        assert sent == [
            (
                {
                    "type": "anywidget-bundle:response",
                    "version": 1,
                    "id": "request-1",
                    "path": app_name,
                },
                [app_source.encode("utf-8")],
            )
        ]
    finally:
        notebook.close()
