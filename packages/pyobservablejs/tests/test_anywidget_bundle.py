from __future__ import annotations

import json
import pathlib
from collections.abc import Mapping, Sequence
from typing import Any

import pytest
from observablejs._anywidget_bundle import (
    Bundle,
    BundleArtifactError,
    BundledWidget,
)


_APP_SOURCE = "export default { render() {} };"


class _RecordingWidget(BundledWidget):
    sent: list[tuple[dict[str, Any], list[bytes]]]

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self.sent = []
        super().__init__(*args, **kwargs)

    def send(
        self,
        content: dict[str, Any],
        buffers: Sequence[bytes | bytearray | memoryview] | None = None,
    ) -> None:
        self.sent.append((content, [bytes(buffer) for buffer in buffers or []]))


def _write_bundle(
    static_dir: pathlib.Path,
    *,
    entry: str = "index.js",
    app: str = "chunks/app.js",
    style: str | None = "widget.css",
    sources: Mapping[str, str | None] | None = None,
    manifest_updates: Mapping[str, object] | None = None,
) -> None:
    static_dir.mkdir(parents=True, exist_ok=True)
    entry_path = static_dir.joinpath(*entry.split("/"))
    entry_path.parent.mkdir(parents=True, exist_ok=True)
    entry_path.write_text(_APP_SOURCE, encoding="utf-8")
    if style is not None:
        style_path = static_dir.joinpath(*style.split("/"))
        style_path.parent.mkdir(parents=True, exist_ok=True)
        style_path.write_text(".widget {}", encoding="utf-8")

    module_sources = {app: _APP_SOURCE} if sources is None else sources
    for module_path, source in module_sources.items():
        module = static_dir.joinpath(*module_path.split("/"))
        module.parent.mkdir(parents=True, exist_ok=True)
        if source is None:
            module.mkdir()
        else:
            module.write_text(source, encoding="utf-8")

    manifest: dict[str, object] = {
        "version": 1,
        "entry": entry,
        "style": style,
        "app": app,
        "modules": list(module_sources),
    }
    if manifest_updates is not None:
        manifest.update(manifest_updates)
    (static_dir / "anywidget.json").write_text(
        json.dumps(manifest),
        encoding="utf-8",
    )


def _widget_class_for_static_dir(static_dir: pathlib.Path) -> type[_RecordingWidget]:
    bundle_config = Bundle(static_dir=static_dir)

    class StaticWidget(_RecordingWidget):
        bundle = bundle_config

    return StaticWidget


def _request(
    widget: _RecordingWidget,
    module_path: object = "chunks/app.js",
    *,
    request_id: object = "request-1",
    version: object = 1,
) -> tuple[dict[str, Any], list[bytes]]:
    widget._handle_custom_msg(
        {
            "type": "anywidget-bundle:request",
            "version": version,
            "id": request_id,
            "path": module_path,
        },
        [],
    )
    return widget.sent[-1]


def test_bundle_returns_manifest_assets(tmp_path: pathlib.Path) -> None:
    static_dir = tmp_path / "static"
    _write_bundle(static_dir)

    esm, css = Bundle(static_dir=static_dir).anywidget_assets()

    assert esm == static_dir / "index.js"
    assert css == static_dir / "widget.css"


def test_bundle_supports_manifest_without_css(tmp_path: pathlib.Path) -> None:
    static_dir = tmp_path / "static"
    _write_bundle(static_dir, style=None)

    esm, css = Bundle(static_dir=static_dir).anywidget_assets()

    assert esm == static_dir / "index.js"
    assert css == ""


@pytest.mark.parametrize(
    ("dev_entry", "expected_path"),
    [
        ("/@anywidget-bundle/entry", "/@anywidget-bundle/entry?anywidget"),
        ("/@weather-widget/entry", "/@weather-widget/entry?anywidget"),
    ],
)
def test_bundle_uses_configured_dev_server_entry(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: pathlib.Path,
    dev_entry: str,
    expected_path: str,
) -> None:
    bundle = Bundle(
        static_dir=tmp_path,
        dev_server_env="OBSERVABLEJS_DEV_SERVER",
        dev_entry=dev_entry,
    )
    monkeypatch.setenv("OBSERVABLEJS_DEV_SERVER", "127.0.0.1:5173/")

    esm, css = bundle.anywidget_assets()

    assert esm == f"http://127.0.0.1:5173{expected_path}"
    assert css == ""


def test_bundle_preserves_dev_server_base_path(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: pathlib.Path,
) -> None:
    bundle = Bundle(
        static_dir=tmp_path,
        dev_server_env="OBSERVABLEJS_DEV_SERVER",
    )
    monkeypatch.setenv("OBSERVABLEJS_DEV_SERVER", "https://example.test/docs/")

    esm, css = bundle.anywidget_assets()

    assert esm == "https://example.test/docs/@anywidget-bundle/entry?anywidget"
    assert css == ""


@pytest.mark.parametrize(
    "dev_entry",
    [
        "@weather-widget/entry",
        "//weather-widget/entry",
        "/",
        "/weather-widget/../entry",
        "/weather-widget\\entry",
        "/weather-widget/entry?mode=dev",
        "/weather-widget/entry#dev",
        "/weather-widget/%2e%2e/entry",
    ],
)
def test_bundle_rejects_invalid_dev_entry(
    tmp_path: pathlib.Path,
    dev_entry: str,
) -> None:
    with pytest.raises(ValueError, match="dev_entry"):
        Bundle(static_dir=tmp_path, dev_entry=dev_entry)


def test_bundle_uses_custom_manifest_paths(tmp_path: pathlib.Path) -> None:
    static_dir = tmp_path / "static"
    app_source = "export default { render() { return 'weather'; } };"
    _write_bundle(
        static_dir,
        entry="esm/widget.mjs",
        app="modules/main.mjs",
        style="styles/widget.css",
        sources={
            "modules/main.mjs": app_source,
            "modules/lazy-D4E5F6.mjs": "export const forecast = true;",
        },
    )
    bundle = Bundle(static_dir=static_dir)

    esm, css = bundle.anywidget_assets()

    assert esm == static_dir / "esm/widget.mjs"
    assert css == static_dir / "styles/widget.css"
    assert bundle.read_module("modules/main.mjs") == app_source
    assert (
        bundle.read_module("modules/lazy-D4E5F6.mjs") == "export const forecast = true;"
    )


def test_bundle_resolves_static_dir_at_construction(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: pathlib.Path,
) -> None:
    project_dir = tmp_path / "project"
    static_dir = project_dir / "static"
    _write_bundle(static_dir)
    project_dir.mkdir(exist_ok=True)
    monkeypatch.chdir(project_dir)
    bundle = Bundle(static_dir="static")
    monkeypatch.chdir(tmp_path)

    esm, _css = bundle.anywidget_assets()

    assert esm == static_dir / "index.js"


def test_bundled_widget_sends_module_source_in_one_binary_buffer(
    tmp_path: pathlib.Path,
) -> None:
    static_dir = tmp_path / "static"
    source = "export default { render() {} };" + "x" * (5 * 1024 * 1024)
    _write_bundle(static_dir, sources={"chunks/app.js": source})
    widget = _widget_class_for_static_dir(static_dir)()
    state_before_request = widget.get_state()

    response, buffers = _request(widget)

    assert response == {
        "type": "anywidget-bundle:response",
        "version": 1,
        "id": "request-1",
        "path": "chunks/app.js",
    }
    assert buffers == [source.encode()]
    assert widget.get_state() == state_before_request


def test_bundled_widget_serves_custom_manifest_module(
    tmp_path: pathlib.Path,
) -> None:
    static_dir = tmp_path / "static"
    _write_bundle(
        static_dir,
        entry="esm/widget.mjs",
        app="modules/main.mjs",
        style=None,
        sources={
            "modules/main.mjs": _APP_SOURCE,
            "modules/lazy.mjs": "export const lazy = true;",
        },
    )
    widget = _widget_class_for_static_dir(static_dir)()

    response, buffers = _request(
        widget,
        "modules/lazy.mjs",
        request_id="load-lazy",
    )

    assert response == {
        "type": "anywidget-bundle:response",
        "version": 1,
        "id": "load-lazy",
        "path": "modules/lazy.mjs",
    }
    assert buffers == [b"export const lazy = true;"]


def test_bundled_widget_ignores_unrelated_custom_messages(
    tmp_path: pathlib.Path,
) -> None:
    static_dir = tmp_path / "static"
    _write_bundle(static_dir)
    widget = _widget_class_for_static_dir(static_dir)()

    widget._handle_custom_msg({"type": "another-message"}, [])

    assert widget.sent == []


@pytest.mark.parametrize(
    ("request_id", "module_path", "version", "code"),
    [
        ("request-1", "chunks/app.js", 2, "unsupported_version"),
        ("request-1", "chunks/app.js", True, "unsupported_version"),
        (None, "chunks/app.js", 1, "invalid_request"),
        ("request-1", None, 1, "invalid_request"),
    ],
)
def test_bundled_widget_reports_malformed_requests(
    tmp_path: pathlib.Path,
    request_id: object,
    module_path: object,
    version: object,
    code: str,
) -> None:
    static_dir = tmp_path / "static"
    _write_bundle(static_dir)
    widget = _widget_class_for_static_dir(static_dir)()

    response, buffers = _request(
        widget,
        module_path,
        request_id=request_id,
        version=version,
    )

    assert response["error"]["code"] == code
    assert buffers == []


@pytest.mark.parametrize(
    "module_path",
    [
        "index.js",
        "/chunks/app.js",
        "chunks/../index.js",
        "chunks/app.css",
        "chunks\\app.js",
        "chunks/missing.js",
    ],
)
def test_bundled_widget_rejects_modules_outside_the_manifest(
    tmp_path: pathlib.Path,
    module_path: str,
) -> None:
    static_dir = tmp_path / "static"
    _write_bundle(static_dir)
    widget = _widget_class_for_static_dir(static_dir)()

    response, buffers = _request(widget, module_path)

    assert response["error"] == {
        "code": "invalid_path",
        "message": "Requested module is not part of this bundle.",
    }
    assert buffers == []


def test_bundled_widget_reports_missing_manifest_module_with_sanitized_error(
    tmp_path: pathlib.Path,
) -> None:
    static_dir = tmp_path / "static"
    _write_bundle(
        static_dir,
        sources={},
        manifest_updates={"modules": ["chunks/app.js"]},
    )
    widget = _widget_class_for_static_dir(static_dir)()

    response, buffers = _request(widget)

    assert response["error"] == {
        "code": "not_found",
        "message": "Requested bundle module was not found.",
    }
    assert buffers == []


def test_bundled_widget_sanitizes_module_read_errors(
    tmp_path: pathlib.Path,
) -> None:
    static_dir = tmp_path / "static"
    _write_bundle(static_dir, sources={"chunks/app.js": None})
    widget = _widget_class_for_static_dir(static_dir)()

    response, buffers = _request(widget)

    assert response["error"] == {
        "code": "read_failed",
        "message": "Requested bundle module could not be read.",
    }
    assert buffers == []


def test_bundled_widget_rejects_symlink_escape(
    tmp_path: pathlib.Path,
) -> None:
    static_dir = tmp_path / "static"
    _write_bundle(static_dir, sources={})
    outside = tmp_path / "outside.js"
    outside.write_text(_APP_SOURCE, encoding="utf-8")
    module = static_dir / "chunks" / "app.js"
    module.parent.mkdir(parents=True)
    try:
        module.symlink_to(outside)
    except (OSError, NotImplementedError) as error:
        pytest.skip(f"symlinks are unavailable: {error}")
    manifest = json.loads((static_dir / "anywidget.json").read_text())
    manifest["modules"] = ["chunks/app.js"]
    (static_dir / "anywidget.json").write_text(json.dumps(manifest))
    widget = _widget_class_for_static_dir(static_dir)()

    response, buffers = _request(widget)

    assert response == {
        "type": "anywidget-bundle:response",
        "version": 1,
        "id": "request-1",
        "path": "chunks/app.js",
        "error": {
            "code": "invalid_path",
            "message": "Requested module is not part of this bundle.",
        },
    }
    assert buffers == []


def test_bundled_widget_rejects_symlinked_module_directory_escape(
    tmp_path: pathlib.Path,
) -> None:
    static_dir = tmp_path / "static"
    _write_bundle(static_dir, app="modules/main.mjs", sources={})
    outside_dir = tmp_path / "outside"
    outside_dir.mkdir()
    (outside_dir / "main.mjs").write_text(_APP_SOURCE, encoding="utf-8")
    try:
        (static_dir / "modules").symlink_to(outside_dir, target_is_directory=True)
    except (OSError, NotImplementedError) as error:
        pytest.skip(f"symlinks are unavailable: {error}")
    manifest = json.loads((static_dir / "anywidget.json").read_text())
    manifest["modules"] = ["modules/main.mjs"]
    (static_dir / "anywidget.json").write_text(json.dumps(manifest))
    widget = _widget_class_for_static_dir(static_dir)()

    response, buffers = _request(widget, "modules/main.mjs")

    assert response == {
        "type": "anywidget-bundle:response",
        "version": 1,
        "id": "request-1",
        "path": "modules/main.mjs",
        "error": {
            "code": "invalid_path",
            "message": "Requested module is not part of this bundle.",
        },
    }
    assert buffers == []


@pytest.mark.parametrize(
    "manifest",
    [
        [],
        {"version": 2},
        {
            "version": 1,
            "entry": "index.js",
            "app": "chunks/app.js",
            "modules": ["chunks/app.js"],
        },
        {
            "version": 1,
            "entry": "../widget.js",
            "style": "widget.css",
            "app": "chunks/app.js",
            "modules": ["chunks/app.js"],
        },
        {
            "version": 1,
            "entry": "widget.css",
            "style": "widget.css",
            "app": "chunks/app.js",
            "modules": ["chunks/app.js"],
        },
        {
            "version": 1,
            "entry": "index.js",
            "style": "../styles/widget.css",
            "app": "chunks/app.js",
            "modules": ["chunks/app.js"],
        },
        {
            "version": 1,
            "entry": "index.js",
            "style": "styles/widget.js",
            "app": "chunks/app.js",
            "modules": ["chunks/app.js"],
        },
        {
            "version": 1,
            "entry": "index.js",
            "style": None,
            "app": "/chunks/app.js",
            "modules": ["chunks/app.js"],
        },
        {
            "version": 1,
            "entry": "index.js",
            "style": None,
            "app": "chunks/app.css",
            "modules": ["chunks/app.css"],
        },
        {
            "version": 1,
            "entry": "index.js",
            "style": None,
            "app": "chunks/app.js",
            "modules": "chunks/app.js",
        },
        {
            "version": 1,
            "entry": "index.js",
            "style": None,
            "app": "chunks/app.js",
            "modules": ["chunks/../app.js"],
        },
        {
            "version": 1,
            "entry": "index.js",
            "style": None,
            "app": "chunks/app.js",
            "modules": ["chunks/app.js", "chunks/app.js"],
        },
        {
            "version": 1,
            "entry": "index.js",
            "style": None,
            "app": "chunks/app.js",
            "modules": ["chunks/lazy.js"],
        },
        {
            "version": 1,
            "entry": "index.js",
            "style": None,
            "app": "chunks/app.js",
            "modules": ["chunks/app.js", "index.js"],
        },
        {
            "version": 1,
            "entry": "index.js",
            "style": None,
            "app": "chunks/[name].js",
            "modules": ["chunks/[name].js"],
        },
        {
            "version": 1,
            "entry": "index.js",
            "style": None,
            "app": "modules/CON.js",
            "modules": ["modules/CON.js"],
        },
        {
            "version": 1,
            "entry": "index.js",
            "style": None,
            "app": "chunks/app.js",
            "modules": ["chunks/app.js", "chunks/APP.js"],
        },
        {
            "version": 1,
            "entry": "index.js",
            "style": None,
            "app": "modules/main.js",
            "modules": ["modules/main.js", "modules/main.js/lazy.js"],
        },
        {
            "version": 1,
            "entry": "index.js",
            "style": "chunks/app.js/widget.css",
            "app": "chunks/app.js",
            "modules": ["chunks/app.js"],
        },
    ],
    ids=[
        "not-an-object",
        "unsupported-version",
        "missing-style",
        "entry-traversal",
        "entry-suffix",
        "style-traversal",
        "style-suffix",
        "app-absolute",
        "app-suffix",
        "modules-not-a-list",
        "module-traversal",
        "duplicate-modules",
        "app-missing-from-modules",
        "entry-in-modules",
        "template-token",
        "reserved-filename",
        "case-folded-module-collision",
        "ancestor-module-collision",
        "style-module-ancestor-collision",
    ],
)
def test_bundle_rejects_malformed_manifest(
    tmp_path: pathlib.Path,
    manifest: object,
) -> None:
    static_dir = tmp_path / "static"
    static_dir.mkdir()
    (static_dir / "anywidget.json").write_text(json.dumps(manifest))

    with pytest.raises(BundleArtifactError, match="anywidget bundle manifest"):
        Bundle(static_dir).anywidget_assets()


@pytest.mark.parametrize(
    ("entry", "app"),
    [
        ("straße.js", "STRASSE.js"),
        ("İ.js", "i̇.js"),
        ("Σ.js", "σ.js"),
        ("é.js", "é.js"),
        ("Ᲊ.js", "ᲊ.js"),
        ("Ɤ.js", "ɤ.js"),
        ("𐵐.js", "𐵰.js"),
        ("𖺠.js", "𖺻.js"),
        ("AΣ𐵐.js", "aσ𐵰.js"),
    ],
)
def test_bundle_rejects_portable_caseless_artifact_collisions(
    tmp_path: pathlib.Path,
    entry: str,
    app: str,
) -> None:
    static_dir = tmp_path / "static"
    _write_bundle(
        static_dir,
        entry=entry,
        app=app,
        style=None,
        sources={app: _APP_SOURCE},
    )

    with pytest.raises(BundleArtifactError, match="artifact paths must not collide"):
        Bundle(static_dir).anywidget_assets()


def test_bundle_rejects_unpaired_surrogate_artifact_path(
    tmp_path: pathlib.Path,
) -> None:
    static_dir = tmp_path / "static"
    static_dir.mkdir()
    manifest = {
        "version": 1,
        "entry": "index.js",
        "style": None,
        "app": "\ud800.js",
        "modules": ["\ud800.js"],
    }
    (static_dir / "anywidget.json").write_text(json.dumps(manifest))

    with pytest.raises(BundleArtifactError, match="manifest app"):
        Bundle(static_dir).anywidget_assets()


def test_bundle_rejects_normalization_version_sensitive_combining_mark(
    tmp_path: pathlib.Path,
) -> None:
    static_dir = tmp_path / "static"
    _write_bundle(
        static_dir,
        entry="A\u0315\u0897.js",
        app="a\u0897\u0315.js",
        style=None,
        sources={"a\u0897\u0315.js": _APP_SOURCE},
    )

    with pytest.raises(BundleArtifactError, match="manifest entry"):
        Bundle(static_dir).anywidget_assets()


def test_bundle_accepts_astral_unicode_artifact_path(
    tmp_path: pathlib.Path,
) -> None:
    static_dir = tmp_path / "static"
    _write_bundle(static_dir, entry="😀.js", style=None)

    esm, css = Bundle(static_dir).anywidget_assets()

    assert esm == static_dir / "😀.js"
    assert css == ""


def test_bundle_reports_missing_manifest(
    tmp_path: pathlib.Path,
) -> None:
    static_dir = tmp_path / "static"
    static_dir.mkdir()

    with pytest.raises(BundleArtifactError, match="manifest is missing"):
        Bundle(static_dir).anywidget_assets()


def test_bundle_reports_invalid_json_manifest(
    tmp_path: pathlib.Path,
) -> None:
    static_dir = tmp_path / "static"
    static_dir.mkdir()

    (static_dir / "anywidget.json").write_text("{")
    with pytest.raises(BundleArtifactError, match="manifest is not valid JSON"):
        Bundle(static_dir).anywidget_assets()
