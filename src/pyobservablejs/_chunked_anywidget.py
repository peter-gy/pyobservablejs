"""anywidget base classes for Vite-built chunked frontends."""

from __future__ import annotations

import dataclasses
import os
import pathlib
from collections.abc import Mapping
from typing import Any, ClassVar, cast

import anywidget
import traitlets
from anywidget.experimental import command as anywidget_command


@dataclasses.dataclass(frozen=True)
class ChunkedAnyWidgetFrontend:
    """Resolve anywidget assets and serve built JavaScript chunks."""

    static_dir: pathlib.Path
    dev_server_env: str | None = None
    dev_module: str | None = None
    entry_module: str = "index.js"
    css_file: str = "widget.css"
    chunk_dir: str = "chunks"

    def with_static_dir(
        self, static_dir: str | pathlib.Path
    ) -> ChunkedAnyWidgetFrontend:
        return dataclasses.replace(self, static_dir=pathlib.Path(static_dir))

    def anywidget_assets(self) -> tuple[str | pathlib.Path, str | pathlib.Path]:
        dev_server = self._dev_server()
        if dev_server is not None:
            return f"{dev_server}/{self._dev_module()}", ""
        return self.static_dir / self.entry_module, self.static_dir / self.css_file

    def read_module(self, module_path: object) -> str:
        if not isinstance(module_path, str):
            raise TypeError("module path must be a string")
        path = pathlib.PurePosixPath(module_path)
        if (
            path.is_absolute()
            or len(path.parts) < 2
            or path.parts[0] != self.chunk_dir
            or ".." in path.parts
            or path.suffix != ".js"
        ):
            raise ValueError(f"unsupported widget module path: {module_path}")
        root = self.static_dir.resolve()
        resolved = (root / pathlib.Path(*path.parts)).resolve()
        try:
            resolved.relative_to(root)
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

    def _dev_module(self) -> str:
        if self.dev_module is None:
            raise ValueError("dev_module is required when dev_server_env is set")
        return self.dev_module.lstrip("/")


class ChunkedAnyWidget(anywidget.AnyWidget):
    """anywidget model that serves Vite-built JavaScript chunks on demand."""

    _frontend: ClassVar[ChunkedAnyWidgetFrontend]
    _esm_module_request = traitlets.Dict(default_value={}).tag(sync=True)
    _esm_module_response = traitlets.Dict(default_value={}).tag(sync=True)

    @traitlets.observe("_esm_module_request")
    def _respond_to_esm_module_request(self, change: dict[str, Any]) -> None:
        request = (
            cast(Mapping[str, object], change["new"])
            if isinstance(change["new"], Mapping)
            else {}
        )
        self.set_trait(
            "_esm_module_response",
            self._module_response(request.get("path"), seq=request.get("seq")),
        )

    @anywidget_command
    def read_esm_module(
        self, msg: object, _buffers: list[bytes]
    ) -> tuple[dict[str, Any], list[bytes]]:
        request = cast(Mapping[str, object], msg) if isinstance(msg, Mapping) else {}
        return self._module_response(request.get("path")), []

    def _module_response(
        self, request_path: object, *, seq: object | None = None
    ) -> dict[str, Any]:
        response: dict[str, Any] = {"path": request_path}
        if seq is not None:
            response["seq"] = seq
        try:
            response["source"] = self._frontend.read_module(request_path)
        except Exception as error:
            response["error"] = f"{type(error).__name__}: {error}"
        return response
