"""Bundle assets and request JavaScript modules through anywidget traitlets."""

from __future__ import annotations

import dataclasses
import os
import pathlib
from collections.abc import Mapping
from typing import Any, ClassVar, cast

import anywidget
import traitlets


_MODULE_REQUEST_TRAIT = "_anywidget_bundle_module_request"
_MODULE_RESPONSE_TRAIT = "_anywidget_bundle_module_response"


@dataclasses.dataclass(frozen=True)
class Bundle:
    """Resolve anywidget assets and read built JavaScript modules on request."""

    static_dir: pathlib.Path
    dev_server_env: str | None = None
    dev_entry: str = "/@anywidget-bundle/entry?anywidget"
    entry_file: str = "widget.js"
    css_file: str = "widget.css"
    module_dir: str = "chunks"

    def with_static_dir(self, static_dir: str | pathlib.Path) -> Bundle:
        return dataclasses.replace(self, static_dir=pathlib.Path(static_dir))

    def anywidget_assets(self) -> tuple[str | pathlib.Path, str | pathlib.Path]:
        dev_server = self._dev_server()
        if dev_server is not None:
            return f"{dev_server}/{self.dev_entry.lstrip('/')}", ""
        return self.static_dir / self.entry_file, self.static_dir / self.css_file

    def read_module(self, module_path: object) -> str:
        if not isinstance(module_path, str):
            raise TypeError("module path must be a string")
        path = pathlib.PurePosixPath(module_path)
        module_dir = pathlib.PurePosixPath(self.module_dir.strip("/"))
        if (
            path.is_absolute()
            or not module_dir.parts
            or path.parts[: len(module_dir.parts)] != module_dir.parts
            or len(path.parts) <= len(module_dir.parts)
            or ".." in path.parts
            or path.suffix != ".js"
        ):
            raise ValueError(f"unsupported widget module path: {module_path}")

        root = self.static_dir.resolve()
        module_root = (root / pathlib.Path(*module_dir.parts)).resolve()
        resolved = (root / pathlib.Path(*path.parts)).resolve()
        try:
            module_root.relative_to(root)
            resolved.relative_to(root)
            resolved.relative_to(module_root)
        except ValueError as error:
            raise ValueError(
                f"unsupported widget module path: {module_path}"
            ) from error
        return resolved.read_text(encoding="utf-8")

    def _dev_server(self) -> str | None:
        if self.dev_server_env is None:
            return None
        dev_server = os.environ.get(self.dev_server_env, "").strip().rstrip("/")
        if not dev_server:
            return None
        if not dev_server.startswith(("http://", "https://")):
            dev_server = f"http://{dev_server}"
        return dev_server


class BundledWidget(anywidget.AnyWidget):
    """anywidget model that serves bundle modules through synced traitlets."""

    bundle: ClassVar[Bundle]
    _anywidget_bundle_module_request = traitlets.Dict(default_value={}).tag(sync=True)
    _anywidget_bundle_module_response = traitlets.Dict(default_value={}).tag(sync=True)

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        esm, css = self.bundle.anywidget_assets()
        self._esm = _asset_text(esm)
        self._css = _asset_text(css)
        super().__init__(*args, **kwargs)

    @traitlets.observe(_MODULE_REQUEST_TRAIT)
    def _respond_to_module_request(self, change: dict[str, Any]) -> None:
        request = (
            cast(Mapping[str, object], change["new"])
            if isinstance(change["new"], Mapping)
            else {}
        )
        self.set_trait(
            _MODULE_RESPONSE_TRAIT,
            self._module_response(request.get("path"), seq=request.get("seq")),
        )

    def _module_response(
        self, request_path: object, *, seq: object | None = None
    ) -> dict[str, Any]:
        response: dict[str, Any] = {"path": request_path}
        if seq is not None:
            response["seq"] = seq
        try:
            response["source"] = self.bundle.read_module(request_path)
        except Exception as error:
            response["error"] = f"{type(error).__name__}: {error}"
        return response


def _asset_text(asset: str | pathlib.Path) -> str:
    if isinstance(asset, pathlib.Path):
        return asset.read_text(encoding="utf-8")
    return asset
