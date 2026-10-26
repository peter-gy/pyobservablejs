"""Verify pinned V8 inputs, then build the native extension through Maturin.

PEP 517 hooks delegate to Maturin after `prepare` downloads and checks the V8
static library and generated bindings for the build target. The command line
prepares the same environment for direct Cargo commands:

    python native_build.py cargo clippy --workspace --locked --all-targets
    python native_build.py env --target x86_64-unknown-linux-gnu --github-env "$GITHUB_ENV"
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import tomllib
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
# The pure wheel and native wheels both serve these frontend assets.
WIDGET_ASSETS = ("index.js", "anywidget.json", "chunks/app.js", "chromium/browser.js")


def require_assets(root: Path = ROOT) -> None:
    """Fail when the frontend build has not produced the packaged assets."""
    static = root / "src" / "observablejs" / "static"
    missing = [name for name in WIDGET_ASSETS if not (static / name).is_file()]
    if missing:
        details = "\n".join(f"  - {static / name}" for name in missing)
        raise RuntimeError(
            f"Run pnpm build before packaging pyobservablejs:\n{details}"
        )


def workspace() -> Path:
    """The Cargo workspace of the crate that `[tool.maturin]` builds."""
    pyproject = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    manifest = (ROOT / pyproject["tool"]["maturin"]["manifest-path"]).resolve()
    for directory in manifest.parents:
        if (directory / "Cargo.lock").is_file():
            return directory
    raise RuntimeError(f"No Cargo.lock above {manifest}")


def _download(spec: dict[str, Any]) -> Path:
    cache = (
        Path(os.environ.get("CARGO_HOME", Path.home() / ".cargo"))
        / "pyobservablejs-v8"
        / spec["sha256"]
    )
    cache.mkdir(parents=True, exist_ok=True)
    destination = cache / spec["url"].rsplit("/", 1)[1]
    if destination.is_file():
        with destination.open("rb") as cached:
            if hashlib.file_digest(cached, "sha256").hexdigest() == spec["sha256"]:
                return destination
    print(f"Fetching verified V8 input {destination.name}", file=sys.stderr)
    temporary = None
    try:
        with (
            urllib.request.urlopen(spec["url"], timeout=120) as response,
            tempfile.NamedTemporaryFile(dir=cache, delete=False) as output,
        ):
            temporary = Path(output.name)
            digest = hashlib.sha256()
            size = 0
            while chunk := response.read(1024 * 1024):
                size += len(chunk)
                if size > spec["size"]:
                    raise RuntimeError(
                        f"V8 input exceeds its pinned size: {spec['url']}"
                    )
                digest.update(chunk)
                output.write(chunk)
        if size != spec["size"] or digest.hexdigest() != spec["sha256"]:
            raise RuntimeError(f"V8 input failed SHA-256 verification: {spec['url']}")
        temporary.replace(destination)
        return destination
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _target(args: list[str]) -> str:
    for index, arg in enumerate(args):
        if arg == "--":
            break
        if arg in {"--features", "-F", "--all-features", "--no-default-features"} or (
            arg.startswith(("--features=", "-F"))
        ):
            raise RuntimeError(
                "pyobservablejs builds use the fixed V8 features in native-archives.json"
            )
        if arg == "--target":
            return args[index + 1]
        if arg.startswith("--target="):
            return arg.partition("=")[2]
    if target := os.environ.get("CARGO_BUILD_TARGET"):
        return target
    version = subprocess.check_output(
        ["rustc", "-vV"], encoding="utf-8", cwd=workspace()
    )
    return next(
        line.removeprefix("host: ")
        for line in version.splitlines()
        if line.startswith("host: ")
    )


def prepare(
    args: list[str], target: str | None = None, *, download: bool = True
) -> dict[str, str]:
    """Return and apply the Cargo environment for one verified V8 target."""
    target = target or _target(args)
    root = workspace()
    pinned = json.loads((ROOT / "native-archives.json").read_text(encoding="utf-8"))
    if target not in pinned["targets"]:
        raise RuntimeError(
            f"pyobservablejs native builds need a pinned V8 archive. "
            f"Target {target!r} has none in native-archives.json."
        )
    flags = (
        os.environ["CARGO_ENCODED_RUSTFLAGS"].split("\x1f")
        if "CARGO_ENCODED_RUSTFLAGS" in os.environ
        else os.environ.get("RUSTFLAGS", "").split()
    )
    sysroot = subprocess.check_output(
        ["rustc", "--print", "sysroot"], encoding="utf-8", cwd=root
    ).strip()
    # Compiler-generated paths in the extension use stable prefixes.
    prefixes: dict[str, str] = {}
    for path, replacement in (
        (Path.home(), "build-home"),
        (Path(os.environ.get("CARGO_HOME", Path.home() / ".cargo")), "cargo"),
        (root, "pyobservablejs"),
        (Path(sysroot), "rust-toolchain"),
    ):
        for spelling in {str(path), path.as_posix()}:
            prefixes[spelling] = replacement
    for prefix, replacement in sorted(
        prefixes.items(), key=lambda item: (len(item[0]), item[0])
    ):
        flag = f"--remap-path-prefix={prefix}={replacement}"
        if flag not in flags:
            flags.append(flag)
    environment = {
        "CARGO_ENCODED_RUSTFLAGS": "\x1f".join(flag for flag in flags if flag)
    }
    if target.endswith("-apple-darwin"):
        minimum = pinned["macosDeploymentTarget"]
        deployment_target = os.environ.get("MACOSX_DEPLOYMENT_TARGET", minimum)
        if not re.fullmatch(r"[0-9]+(?:\.[0-9]+){0,2}", deployment_target):
            raise RuntimeError(
                f"MACOSX_DEPLOYMENT_TARGET must be a macOS version such as {minimum}"
            )
        version = tuple(map(int, deployment_target.split(".")))
        floor = tuple(map(int, minimum.split(".")))
        if version + (0,) * (3 - len(version)) < floor + (0,) * (3 - len(floor)):
            raise RuntimeError(
                f"The pinned V8 archives need MACOSX_DEPLOYMENT_TARGET >= {minimum}, "
                f"got {deployment_target!r}"
            )
        environment["MACOSX_DEPLOYMENT_TARGET"] = deployment_target
    metadata = json.loads(
        subprocess.check_output(
            [
                "cargo",
                "metadata",
                "--locked",
                "--format-version",
                "1",
                "--filter-platform",
                target,
            ],
            encoding="utf-8",
            cwd=root,
        )
    )
    v8 = [package for package in metadata["packages"] if package["name"] == "v8"]
    if len(v8) != 1 or v8[0]["version"] != pinned["v8Version"]:
        raise RuntimeError("Update native-archives.json for the locked V8 version")
    features = next(
        node["features"]
        for node in metadata["resolve"]["nodes"]
        if node["id"] == v8[0]["id"]
    )
    if sorted(features) != pinned["features"]:
        raise RuntimeError("Update native-archives.json for the selected V8 features")
    if os.environ.get("V8_FORCE_DEBUG") in {"1", "true", "yes"} or os.environ.get(
        "V8_FROM_SOURCE"
    ) in {"1", "true", "yes"}:
        raise RuntimeError(
            "pyobservablejs builds use the verified release V8 archives in native-archives.json"
        )
    if download:
        files = pinned["targets"][target]
        environment.update(
            RUSTY_V8_ARCHIVE=str(_download(files["archive"])),
            RUSTY_V8_SRC_BINDING_PATH=str(_download(files["binding"])),
        )
    os.environ.update(environment)
    return environment


def _maturin_args(config_settings: dict[str, object] | None) -> list[str]:
    import maturin

    return maturin.get_maturin_pep517_args(config_settings)


def build_wheel(
    wheel_directory: str,
    config_settings: dict[str, object] | None = None,
    metadata_directory: str | None = None,
) -> str:
    import maturin

    require_assets()
    prepare(_maturin_args(config_settings))
    return maturin.build_wheel(wheel_directory, config_settings, metadata_directory)


def build_editable(
    wheel_directory: str,
    config_settings: dict[str, object] | None = None,
    metadata_directory: str | None = None,
) -> str:
    import maturin

    require_assets()
    prepare(_maturin_args(config_settings))
    return maturin.build_editable(wheel_directory, config_settings, metadata_directory)


def build_sdist(
    sdist_directory: str, config_settings: dict[str, object] | None = None
) -> str:
    import maturin

    return maturin.build_sdist(sdist_directory, config_settings)


def get_requires_for_build_wheel(
    config_settings: dict[str, object] | None = None,
) -> list[str]:
    import maturin

    return maturin.get_requires_for_build_wheel(config_settings)


def get_requires_for_build_editable(
    config_settings: dict[str, object] | None = None,
) -> list[str]:
    import maturin

    return maturin.get_requires_for_build_editable(config_settings)


def get_requires_for_build_sdist(
    config_settings: dict[str, object] | None = None,
) -> list[str]:
    import maturin

    return maturin.get_requires_for_build_sdist(config_settings)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    env = commands.add_parser("env", help="Write the verified V8 build environment")
    env.add_argument("--target", required=True)
    env.add_argument("--github-env", type=Path)
    env.add_argument("--shell-env", type=Path)
    cargo = commands.add_parser("cargo", help="Run Cargo with the verified V8 inputs")
    cargo.add_argument("args", nargs=argparse.REMAINDER)
    options = parser.parse_args()
    if options.command == "env":
        environment = prepare([], target=options.target)
        if options.github_env:
            with options.github_env.open("a", encoding="utf-8") as output:
                output.writelines(
                    f"{key}={value}\n" for key, value in environment.items()
                )
        if options.shell_env:
            options.shell_env.write_text(
                "".join(
                    f"export {key}={shlex.quote(value)}\n"
                    for key, value in environment.items()
                ),
                encoding="utf-8",
            )
        return
    prepare(options.args)
    raise SystemExit(subprocess.call(["cargo", *options.args], cwd=workspace()))


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        print(error, file=sys.stderr)
        raise SystemExit(1) from error
