"""Load Vite-built anywidget assets and serve their JavaScript modules."""

from __future__ import annotations

import dataclasses
import functools
import json
import os
import pathlib
import unicodedata
from collections.abc import Mapping, Sequence
from typing import Any, ClassVar

import anywidget


_DEFAULT_DEV_ENTRY = "/@anywidget-bundle/entry"
_MANIFEST_FILE = "anywidget.json"
# Version checks use exact integer types because bool compares equal to 1.
_PROTOCOL_VERSION = 1
_REQUEST_TYPE = "anywidget-bundle:request"
_RESPONSE_TYPE = "anywidget-bundle:response"
_JAVASCRIPT_SUFFIXES = frozenset({".js", ".mjs"})
_STYLE_SUFFIXES = frozenset({".css"})
_INVALID_FILENAME_CHARACTERS = frozenset('<>:"|?*[]#')
_RESERVED_FILENAMES = frozenset(
    {"con", "prn", "aux", "nul"}
    | {f"com{index}" for index in range(1, 10)}
    | {f"lpt{index}" for index in range(1, 10)}
)
# Keep recent case pairs explicit so JavaScript and Python produce the same
# collision key when their bundled Unicode databases have different versions.
_RECENT_CASE_PAIRS = {
    0x1C89: 0x1C8A,
    0xA7CB: 0x0264,
    0xA7CC: 0xA7CD,
    0xA7CE: 0xA7CF,
    0xA7D2: 0xA7D3,
    0xA7D4: 0xA7D5,
    0xA7DA: 0xA7DB,
    0xA7DC: 0x019B,
}
# These marks have different combining classes across supported runtime
# Unicode versions, which would make NFC collision checks disagree.
_VERSION_SENSITIVE_COMBINING_MARK_RANGES = (
    (0x0897, 0x0897),
    (0x1ACF, 0x1ADD),
    (0x1AE0, 0x1AEB),
    (0x10D69, 0x10D6D),
    (0x10EFA, 0x10EFB),
    (0x10EFD, 0x10EFF),
    (0x113CE, 0x113D0),
    (0x11F41, 0x11F42),
    (0x1612F, 0x1612F),
    (0x1E08F, 0x1E08F),
    (0x1E4EC, 0x1E4EF),
    (0x1E5EE, 0x1E5EF),
    (0x1E6E3, 0x1E6E3),
    (0x1E6E6, 0x1E6E6),
    (0x1E6EE, 0x1E6EF),
    (0x1E6F5, 0x1E6F5),
)


class BundleArtifactError(RuntimeError):
    """Raised when a built bundle is missing or has an invalid manifest."""


class BundleModuleError(RuntimeError):
    """Raised when a requested JavaScript module cannot be served."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclasses.dataclass(frozen=True)
class _BundleManifest:
    entry: str
    style: str | None
    app: str
    modules: frozenset[str]


@dataclasses.dataclass(frozen=True, init=False)
class Bundle:
    """Resolve assets from a version 1 ``anywidget.json`` manifest.

    ``static_dir`` is resolved when the bundle is created, so later working
    directory changes do not affect artifact lookup. ``dev_server_env`` names
    the environment variable that selects a Vite server base URL. ``dev_entry``
    is the server path for the development module. The loader appends the
    anywidget query parameter when it builds the development URL.
    """

    static_dir: pathlib.Path
    dev_server_env: str | None
    dev_entry: str

    def __init__(
        self,
        static_dir: str | pathlib.Path,
        dev_server_env: str | None = None,
        dev_entry: str = _DEFAULT_DEV_ENTRY,
    ) -> None:
        object.__setattr__(
            self,
            "static_dir",
            pathlib.Path(static_dir).expanduser().resolve(),
        )
        object.__setattr__(self, "dev_server_env", dev_server_env)
        object.__setattr__(self, "dev_entry", _validate_dev_entry(dev_entry))

    def anywidget_assets(self) -> tuple[str | pathlib.Path, str | pathlib.Path]:
        """Return the anywidget ESM and CSS assets for this bundle."""

        dev_server = self._dev_server()
        if dev_server is not None:
            # Vite owns the app graph and imported styles during development.
            return f"{dev_server}{self.dev_entry}?anywidget", ""

        # The built path gives anywidget the bootstrap and stylesheet. The
        # bootstrap requests its app graph through the custom-message handler.
        manifest = self._manifest
        entry = self._artifact_path(manifest.entry)
        style = (
            self._artifact_path(manifest.style) if manifest.style is not None else ""
        )
        return entry, style

    def read_module(self, module_path: object) -> str:
        """Read an exact JavaScript module listed by the bundle manifest."""

        if not isinstance(module_path, str) or not _is_javascript_path(module_path):
            raise BundleModuleError(
                "invalid_path",
                "Requested module is not part of this bundle.",
            )
        if module_path not in self._manifest.modules:
            raise BundleModuleError(
                "invalid_path",
                "Requested module is not part of this bundle.",
            )

        try:
            module = self._artifact_path(module_path)
        except BundleArtifactError as error:
            raise BundleModuleError(
                "invalid_path",
                "Requested module is not part of this bundle.",
            ) from error

        try:
            return module.read_text(encoding="utf-8")
        except FileNotFoundError as error:
            raise BundleModuleError(
                "not_found",
                "Requested bundle module was not found.",
            ) from error
        except (OSError, UnicodeError) as error:
            raise BundleModuleError(
                "read_failed",
                "Requested bundle module could not be read.",
            ) from error

    # Parse and validate the manifest once so every module request uses one
    # stable allowlist.
    @functools.cached_property
    def _manifest(self) -> _BundleManifest:
        manifest_path = self._artifact_path(_MANIFEST_FILE)
        try:
            raw = json.loads(manifest_path.read_text(encoding="utf-8"))
        except FileNotFoundError as error:
            raise BundleArtifactError("anywidget bundle manifest is missing") from error
        except json.JSONDecodeError as error:
            raise BundleArtifactError(
                "anywidget bundle manifest is not valid JSON"
            ) from error
        except (OSError, UnicodeError) as error:
            raise BundleArtifactError(
                "anywidget bundle manifest could not be read"
            ) from error
        return _parse_manifest(raw)

    def _artifact_path(self, relative_path: str) -> pathlib.Path:
        candidate = self.static_dir.joinpath(
            *pathlib.PurePosixPath(relative_path).parts
        )
        try:
            # Resolve symlinks before containment so each artifact target stays
            # inside static_dir.
            resolved = candidate.resolve()
        except (OSError, RuntimeError) as error:
            raise BundleArtifactError(
                "anywidget bundle artifact could not be resolved"
            ) from error
        try:
            resolved.relative_to(self.static_dir)
        except ValueError as error:
            raise BundleArtifactError(
                "anywidget bundle artifact escapes its static directory"
            ) from error
        return resolved

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
    """anywidget model that serves bundle modules over custom messages."""

    bundle: ClassVar[Bundle]
    include_bundle_css: ClassVar[bool] = True

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        # AnyWidget snapshots instance-level _esm and _css when it creates their
        # synchronized traits, so materialize file paths before its initializer.
        esm, css = self.bundle.anywidget_assets()
        self._esm = _asset_text(esm)
        self._css = _asset_text(css) if self.include_bundle_css else ""
        super().__init__(*args, **kwargs)
        self.on_msg(self._handle_bundle_message)

    def _handle_bundle_message(
        self,
        _widget: object,
        content: object,
        _buffers: Sequence[memoryview],
    ) -> None:
        # Custom messages share the widget comm. Leave envelopes owned by other
        # features untouched.
        if not isinstance(content, Mapping) or content.get("type") != _REQUEST_TYPE:
            return

        request_id = content.get("id")
        module_path = content.get("path")
        # Imports can resolve out of order, so every response carries enough
        # request identity for the browser to settle the matching promise.
        response: dict[str, Any] = {
            "type": _RESPONSE_TYPE,
            "version": _PROTOCOL_VERSION,
            "id": request_id if isinstance(request_id, str) else "",
            "path": module_path if isinstance(module_path, str) else "",
        }

        if (
            type(content.get("version")) is not int
            or content.get("version") != _PROTOCOL_VERSION
        ):
            response["error"] = {
                "code": "unsupported_version",
                "message": "Bundle module protocol version must be 1.",
            }
            self.send(response)
            return
        if (
            not isinstance(request_id, str)
            or not request_id
            or not isinstance(module_path, str)
        ):
            response["error"] = {
                "code": "invalid_request",
                "message": "Bundle module request requires string id and path fields.",
            }
            self.send(response)
            return

        try:
            source = self.bundle.read_module(module_path)
        except BundleModuleError as error:
            response["error"] = {"code": error.code, "message": str(error)}
            self.send(response)
            return
        # Keep source outside synchronized state and JSON by sending one binary
        # comm buffer.
        self.send(response, buffers=[source.encode("utf-8")])


def _parse_manifest(raw: object) -> _BundleManifest:
    if not isinstance(raw, Mapping):
        raise BundleArtifactError("anywidget bundle manifest must be an object")
    if type(raw.get("version")) is not int or raw.get("version") != 1:
        raise BundleArtifactError("anywidget bundle manifest version must be 1")
    entry = raw.get("entry")
    if not isinstance(entry, str) or not _is_javascript_path(entry):
        raise BundleArtifactError(
            "anywidget bundle manifest entry must be a relative JavaScript path"
        )

    if "style" not in raw:
        raise BundleArtifactError(
            "anywidget bundle manifest style must be a relative CSS path or null"
        )
    style = raw.get("style")
    if style is None:
        manifest_style = None
    elif isinstance(style, str) and _is_artifact_path(style, _STYLE_SUFFIXES):
        manifest_style = style
    else:
        raise BundleArtifactError(
            "anywidget bundle manifest style must be a relative CSS path or null"
        )

    app = raw.get("app")
    if not isinstance(app, str) or not _is_javascript_path(app):
        raise BundleArtifactError(
            "anywidget bundle manifest app must be a relative JavaScript path"
        )

    modules = raw.get("modules")
    if not isinstance(modules, list):
        raise BundleArtifactError(
            "anywidget bundle manifest modules must be unique JavaScript paths"
        )
    module_paths: list[str] = []
    for module_path in modules:
        if not isinstance(module_path, str) or not _is_javascript_path(module_path):
            raise BundleArtifactError(
                "anywidget bundle manifest modules must be unique JavaScript paths"
            )
        module_paths.append(module_path)
    # anywidget evaluates entry directly. The runtime requests app and split
    # chunks through modules, which is the transport allowlist.
    if (
        not module_paths
        or len(module_paths) != len(set(module_paths))
        or app not in module_paths
        or entry in module_paths
    ):
        raise BundleArtifactError(
            "anywidget bundle manifest modules must contain unique JavaScript paths, include app, and exclude entry"
        )
    artifact_paths = [_MANIFEST_FILE, entry, *module_paths]
    if manifest_style is not None:
        artifact_paths.append(manifest_style)
    if _artifact_paths_conflict(artifact_paths):
        raise BundleArtifactError(
            "anywidget bundle manifest artifact paths must not collide"
        )
    return _BundleManifest(
        entry=entry,
        style=manifest_style,
        app=app,
        modules=frozenset(module_paths),
    )


def _is_javascript_path(value: str) -> bool:
    return _is_artifact_path(value, _JAVASCRIPT_SUFFIXES)


def _is_artifact_path(value: str, suffixes: frozenset[str]) -> bool:
    return (
        _is_safe_relative_path(value)
        and pathlib.PurePosixPath(value).suffix in suffixes
    )


def _is_safe_relative_path(value: str) -> bool:
    # Artifact names cross build, wheel, install, and browser boundaries. Accept
    # the portable subset that resolves consistently on supported filesystems.
    parts = value.split("/")
    return (
        bool(value)
        and all(part not in ("", ".", "..") for part in parts)
        and "\\" not in value
        and all(not part.endswith((".", " ")) for part in parts)
        and all(
            not any(
                character in _INVALID_FILENAME_CHARACTERS
                or ord(character) < 32
                or ord(character) == 127
                or 0xD800 <= ord(character) <= 0xDFFF
                or _is_version_sensitive_combining_mark(ord(character))
                for character in part
            )
            for part in parts
        )
        and all(
            part.split(".", 1)[0].lower() not in _RESERVED_FILENAMES for part in parts
        )
    )


def _artifact_paths_conflict(paths: Sequence[str]) -> bool:
    # Catch case and normalization aliases plus file-directory overlaps before
    # platform path rules can merge distinct manifest entries.
    normalized = [_portable_case_fold(path) for path in paths]
    return any(
        path == other or path.startswith(f"{other}/")
        for index, path in enumerate(normalized)
        for other_index, other in enumerate(normalized)
        if index != other_index
    )


def _is_version_sensitive_combining_mark(code_point: int) -> bool:
    return any(
        start <= code_point <= end
        for start, end in _VERSION_SENSITIVE_COMBINING_MARK_RANGES
    )


def _portable_case_fold(value: str) -> str:
    # Mirror JavaScript's per-code-point upper-then-lower transform. Python's
    # casefold uses different expansions and would produce a different key.
    normalized = unicodedata.normalize("NFC", value)
    return "".join(
        chr(_compatible_case_code_point(ord(char))).upper().lower()
        for char in normalized
    )


def _compatible_case_code_point(code_point: int) -> int:
    paired = _RECENT_CASE_PAIRS.get(code_point)
    if paired is not None:
        return paired
    if 0x10D50 <= code_point <= 0x10D65:
        return code_point + 0x20
    if 0x16EA0 <= code_point <= 0x16EB8:
        return code_point + 0x1B
    return code_point


def _validate_dev_entry(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("dev_entry must be an absolute URL path")

    # Reject percent escapes before URL concatenation so encoded separators and
    # delimiters never bypass path validation.
    if (
        not value.startswith("/")
        or value.startswith("//")
        or "%" in value
        or not _is_safe_relative_path(value[1:])
    ):
        raise ValueError(
            "dev_entry must be an absolute URL path without query or fragment"
        )
    return value


def _asset_text(asset: str | pathlib.Path) -> str:
    if not isinstance(asset, pathlib.Path):
        return asset
    try:
        return asset.read_text(encoding="utf-8")
    except FileNotFoundError as error:
        raise BundleArtifactError("anywidget bundle asset is missing") from error
    except (OSError, UnicodeError) as error:
        raise BundleArtifactError("anywidget bundle asset could not be read") from error
