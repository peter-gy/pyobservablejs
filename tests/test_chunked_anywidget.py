from __future__ import annotations

import pathlib
from typing import cast

import pytest
from pyobservablejs._chunked_anywidget import ChunkedAnyWidget, ChunkedAnyWidgetFrontend


def _widget_class_for_static_dir(static_dir: pathlib.Path) -> type[ChunkedAnyWidget]:
    static_dir.mkdir(parents=True, exist_ok=True)
    (static_dir / "index.js").write_text(
        "export default { render() {} };",
        encoding="utf-8",
    )
    (static_dir / "widget.css").write_text("", encoding="utf-8")
    frontend = ChunkedAnyWidgetFrontend(static_dir=static_dir)

    class StaticWidget(ChunkedAnyWidget):
        _frontend = frontend
        _esm, _css = frontend.anywidget_assets()

    return StaticWidget


def _traitlet_module_response(
    widget: ChunkedAnyWidget, module_path: str, *, seq: int = 1
) -> dict[str, object]:
    widget.set_trait("_esm_module_request", {"seq": seq, "path": module_path})
    return cast(dict[str, object], getattr(widget, "_esm_module_response"))


def test_chunked_anywidget_frontend_returns_static_assets(
    tmp_path: pathlib.Path,
) -> None:
    frontend = ChunkedAnyWidgetFrontend(static_dir=tmp_path)

    esm, css = frontend.anywidget_assets()

    assert esm == tmp_path / "index.js"
    assert css == tmp_path / "widget.css"


def test_chunked_anywidget_frontend_uses_dev_server_module(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: pathlib.Path,
) -> None:
    frontend = ChunkedAnyWidgetFrontend(
        static_dir=tmp_path,
        dev_server_env="PYOBSERVABLEJS_DEV_SERVER",
        dev_module="js/widget/dev.ts?anywidget",
    )
    monkeypatch.setenv("PYOBSERVABLEJS_DEV_SERVER", "127.0.0.1:5173/")

    esm, css = frontend.anywidget_assets()

    assert esm == "http://127.0.0.1:5173/js/widget/dev.ts?anywidget"
    assert css == ""


def test_chunked_anywidget_serves_chunk_source_over_traitlet(
    tmp_path: pathlib.Path,
) -> None:
    static_dir = tmp_path / "static"
    chunk = static_dir / "chunks" / "app.js"
    chunk.parent.mkdir(parents=True)
    chunk.write_text("export default { render() {} };", encoding="utf-8")

    widget = _widget_class_for_static_dir(static_dir)()

    response = _traitlet_module_response(widget, "chunks/app.js")

    assert response["seq"] == 1
    assert response["path"] == "chunks/app.js"
    assert response.get("source") == "export default { render() {} };"


def test_chunked_anywidget_exposes_chunk_request_traits(
    tmp_path: pathlib.Path,
) -> None:
    widget = _widget_class_for_static_dir(tmp_path / "static")()

    assert "_esm_module_request" in widget.traits()
    assert "_esm_module_response" in widget.traits()


def test_chunked_anywidget_reports_missing_chunks_over_traitlet(
    tmp_path: pathlib.Path,
) -> None:
    widget = _widget_class_for_static_dir(tmp_path / "static")()

    missing = _traitlet_module_response(widget, "chunks/missing.js")

    assert missing["seq"] == 1
    assert missing["path"] == "chunks/missing.js"
    assert "source" not in missing
    assert "FileNotFoundError" in str(missing.get("error"))


@pytest.mark.parametrize(
    "module_path",
    [
        "index.js",
        "/chunks/app.js",
        "chunks/../index.js",
        "chunks/app.css",
    ],
)
def test_chunked_anywidget_rejects_paths_outside_static_chunks(
    tmp_path: pathlib.Path,
    module_path: str,
) -> None:
    static_dir = tmp_path / "static"
    chunk = static_dir / "chunks" / "app.js"
    chunk.parent.mkdir(parents=True)
    chunk.write_text("export default { render() {} };", encoding="utf-8")

    widget = _widget_class_for_static_dir(static_dir)()

    response = _traitlet_module_response(widget, module_path)

    assert response["path"] == module_path
    assert "source" not in response
    assert "unsupported widget module path" in str(response.get("error"))


def test_chunked_anywidget_rejects_symlink_escape(
    tmp_path: pathlib.Path,
) -> None:
    static_dir = tmp_path / "static"
    chunk_dir = static_dir / "chunks"
    chunk_dir.mkdir(parents=True)
    outside = tmp_path / "outside.js"
    outside.write_text("export default { render() {} };", encoding="utf-8")
    escape = chunk_dir / "escape.js"
    try:
        escape.symlink_to(outside)
    except (OSError, NotImplementedError) as error:
        pytest.skip(f"symlinks are unavailable: {error}")

    widget = _widget_class_for_static_dir(static_dir)()

    response = _traitlet_module_response(widget, "chunks/escape.js")

    assert response["path"] == "chunks/escape.js"
    assert "source" not in response
    assert "unsupported widget module path" in str(response.get("error"))
