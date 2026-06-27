from __future__ import annotations

import pathlib
from typing import cast

import pytest
from observablejs._anywidget_bundle import Bundle, BundledWidget


def _widget_class_for_static_dir(static_dir: pathlib.Path) -> type[BundledWidget]:
    static_dir.mkdir(parents=True, exist_ok=True)
    (static_dir / "index.js").write_text(
        "export default { render() {} };",
        encoding="utf-8",
    )
    (static_dir / "widget.css").write_text("", encoding="utf-8")
    bundle_config = Bundle(static_dir=static_dir, entry_file="index.js")

    class StaticWidget(BundledWidget):
        bundle = bundle_config

    return StaticWidget


def _traitlet_module_response(
    widget: BundledWidget, module_path: str, *, seq: int = 1
) -> dict[str, object]:
    widget.set_trait(
        "_anywidget_bundle_module_request",
        {"seq": seq, "path": module_path},
    )
    return cast(
        dict[str, object],
        getattr(widget, "_anywidget_bundle_module_response"),
    )


def test_bundle_returns_static_assets(tmp_path: pathlib.Path) -> None:
    bundle = Bundle(static_dir=tmp_path, entry_file="index.js")

    esm, css = bundle.anywidget_assets()

    assert esm == tmp_path / "index.js"
    assert css == tmp_path / "widget.css"


def test_bundle_uses_dev_server_entry(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: pathlib.Path,
) -> None:
    bundle = Bundle(
        static_dir=tmp_path,
        dev_server_env="OBSERVABLEJS_DEV_SERVER",
        dev_entry="js/widget/dev.ts?anywidget",
    )
    monkeypatch.setenv("OBSERVABLEJS_DEV_SERVER", "127.0.0.1:5173/")

    esm, css = bundle.anywidget_assets()

    assert esm == "http://127.0.0.1:5173/js/widget/dev.ts?anywidget"
    assert css == ""


def test_bundled_widget_serves_module_source_over_traitlet(
    tmp_path: pathlib.Path,
) -> None:
    static_dir = tmp_path / "static"
    module = static_dir / "chunks" / "app.js"
    module.parent.mkdir(parents=True)
    module.write_text("export default { render() {} };", encoding="utf-8")

    widget = _widget_class_for_static_dir(static_dir)()

    response = _traitlet_module_response(widget, "chunks/app.js")

    assert response["seq"] == 1
    assert response["path"] == "chunks/app.js"
    assert response.get("source") == "export default { render() {} };"


def test_bundled_widget_exposes_request_traits(tmp_path: pathlib.Path) -> None:
    widget = _widget_class_for_static_dir(tmp_path / "static")()

    assert "_anywidget_bundle_module_request" in widget.traits()
    assert "_anywidget_bundle_module_response" in widget.traits()


def test_bundled_widget_reports_missing_modules_over_traitlet(
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
def test_bundled_widget_rejects_paths_outside_module_dir(
    tmp_path: pathlib.Path,
    module_path: str,
) -> None:
    static_dir = tmp_path / "static"
    module = static_dir / "chunks" / "app.js"
    module.parent.mkdir(parents=True)
    module.write_text("export default { render() {} };", encoding="utf-8")

    widget = _widget_class_for_static_dir(static_dir)()

    response = _traitlet_module_response(widget, module_path)

    assert response["path"] == module_path
    assert "source" not in response
    assert "unsupported widget module path" in str(response.get("error"))


def test_bundled_widget_rejects_symlink_escape(
    tmp_path: pathlib.Path,
) -> None:
    static_dir = tmp_path / "static"
    module_dir = static_dir / "chunks"
    module_dir.mkdir(parents=True)
    outside = tmp_path / "outside.js"
    outside.write_text("export default { render() {} };", encoding="utf-8")
    escape = module_dir / "escape.js"
    try:
        escape.symlink_to(outside)
    except (OSError, NotImplementedError) as error:
        pytest.skip(f"symlinks are unavailable: {error}")

    widget = _widget_class_for_static_dir(static_dir)()

    response = _traitlet_module_response(widget, "chunks/escape.js")

    assert response["path"] == "chunks/escape.js"
    assert "source" not in response
    assert "unsupported widget module path" in str(response.get("error"))


def test_bundled_widget_rejects_symlinked_module_dir_escape(
    tmp_path: pathlib.Path,
) -> None:
    static_dir = tmp_path / "static"
    static_dir.mkdir()
    outside_dir = tmp_path / "outside"
    outside_dir.mkdir()
    (outside_dir / "app.js").write_text(
        "export default { render() {} };",
        encoding="utf-8",
    )
    try:
        (static_dir / "chunks").symlink_to(outside_dir, target_is_directory=True)
    except (OSError, NotImplementedError) as error:
        pytest.skip(f"symlinks are unavailable: {error}")

    widget = _widget_class_for_static_dir(static_dir)()

    response = _traitlet_module_response(widget, "chunks/app.js")

    assert response["path"] == "chunks/app.js"
    assert "source" not in response
    assert "unsupported widget module path" in str(response.get("error"))
