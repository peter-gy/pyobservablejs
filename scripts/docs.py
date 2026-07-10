from __future__ import annotations

import argparse
from collections.abc import Iterator
from contextlib import contextmanager
import hashlib
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory
from urllib.parse import urlsplit


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DOCS_DIR = PROJECT_ROOT / "docs"
DOCS_WHEEL_DIR = PROJECT_ROOT / "dist" / "docs"
DOCS_BUILD_DIR = DOCS_DIR / "_build"
DOCS_HTML_DIR = DOCS_BUILD_DIR / "html"
DOCS_GENERATED_DIR = DOCS_DIR / ".jupyter-book-marimo"
DOCS_SITE_DIR = DOCS_DIR / "_site"
GENERATED_DOCS_DIRS = (DOCS_BUILD_DIR, DOCS_GENERATED_DIR, DOCS_SITE_DIR)

DEFAULT_PORT = 27331
PREVIEW_HOST = "127.0.0.1"
PUBLIC_WHEEL_PATH = PurePosixPath("public/wheels")
BASE_URL_SEGMENT = re.compile(r"[A-Za-z0-9._~-]+")

MARIMO_CONFIG = "{marimo-config}"
SOURCE_DEPENDENCY = '"pyobservablejs",'
SITE_TEXT_SUFFIXES = {".html", ".js", ".json", ".md", ".mjs"}
# Marimo preinstalls direct references with URL schemes. Resolve the origin in
# its generated bridge, after the browser knows where the static site is served.
BRIDGE_NOTEBOOK_CODE_ASSIGNMENT = (
    '  const notebookCode = getModelString(model, "notebookCode") || '
    "decodeMarimoCode(head) || decodeMarimoCode(body);\n"
)
BRIDGE_NOTEBOOK_CODE_REPLACEMENT = """\
  const notebookCode = resolveSameOriginRequirements(
    getModelString(model, "notebookCode") || decodeMarimoCode(head) || decodeMarimoCode(body)
  );
"""
BRIDGE_MODEL_READER = "var readOutputModel = (model) => {\n"
BRIDGE_MOLAB_NOTEBOOK_CODE_ASSIGNMENT = (
    '    molabNotebookCode: getModelString(model, "molabNotebookCode"),\n'
)
BRIDGE_MOLAB_NOTEBOOK_CODE_REPLACEMENT = '    molabNotebookCode: resolveSameOriginRequirements(getModelString(model, "molabNotebookCode")),\n'
BRIDGE_REQUIREMENT_RESOLVER = r"""var resolveSameOriginRequirements = (code) => {
  if (!code) return code;
  return code.replace(
    /^(\s*#\s*"[^"\n]+\s@\s)(\/[^"\n]+)(",?\s*)$/gm,
    (_match, prefix, path, suffix) => `${prefix}${globalThis.location.origin}${path}${suffix}`
  );
};
"""


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build or preview the pyobservablejs docs."
    )
    subcommands = parser.add_subparsers(dest="command", required=True)

    build = subcommands.add_parser("build", help="Build deployable static HTML.")
    build.set_defaults(func=build_command)

    serve = subcommands.add_parser("serve", help="Build and serve static HTML.")
    serve.add_argument("--port", type=int, default=DEFAULT_PORT)
    serve.set_defaults(func=serve_command)

    args = parser.parse_args()
    args.func(args)


def build_command(_args: argparse.Namespace) -> None:
    build_docs()


def serve_command(args: argparse.Namespace) -> None:
    base_url = configured_base_url()
    build_docs(base_url=base_url)
    with docs_serve_root(base_url) as serve_root:
        preview_url = f"http://{PREVIEW_HOST}:{args.port}{base_url}/"
        print(f"serving {preview_url}", flush=True)
        run(
            [
                sys.executable,
                "-m",
                "http.server",
                "--bind",
                PREVIEW_HOST,
                "--directory",
                str(serve_root),
                str(args.port),
            ]
        )


def build_docs(*, base_url: str | None = None) -> Path:
    base_url = configured_base_url(base_url)
    wheel = build_wheel()
    local_requirement = requirement(relative_reference(wheel))
    check_docs_plugin()

    with source_build_references(local_requirement):
        for directory in GENERATED_DOCS_DIRS:
            remove_tree(directory)
        env = os.environ.copy()
        env["BASE_URL"] = base_url
        run(
            ["uv", "run", "jupyter", "book", "build", "--html", "--strict"],
            cwd=DOCS_DIR,
            env=env,
        )

    install_same_origin_requirement_resolver()
    publish_wheel(wheel, local_requirement, base_url)
    assert_source_dependencies()
    return wheel


def build_wheel() -> Path:
    remove_tree(DOCS_WHEEL_DIR)
    DOCS_WHEEL_DIR.mkdir(parents=True, exist_ok=True)
    run(["uv", "build", "--wheel", "--out-dir", str(DOCS_WHEEL_DIR)])
    return single_wheel(DOCS_WHEEL_DIR)


@contextmanager
def source_build_references(local_requirement: str) -> Iterator[None]:
    paths = interactive_docs()
    originals = {path: path.read_bytes() for path in paths}
    replacement = f'"{local_requirement}",'.encode()
    try:
        for path, source in originals.items():
            updated = source.replace(SOURCE_DEPENDENCY.encode(), replacement)
            if updated == source:
                raise SystemExit(f"Expected pyobservablejs dependency in {path}")
            path.write_bytes(updated)
        yield
    finally:
        for path, source in originals.items():
            path.write_bytes(source)


def interactive_docs() -> list[Path]:
    paths: list[Path] = []
    for path in sorted(DOCS_DIR.rglob("*.md")):
        if any(directory in path.parents for directory in GENERATED_DOCS_DIRS):
            continue
        source = path.read_text(encoding="utf-8")
        if MARIMO_CONFIG not in source:
            continue
        count = source.count(SOURCE_DEPENDENCY)
        if count != 1:
            raise SystemExit(
                f"Expected one pyobservablejs dependency in {path}, found {count}"
            )
        paths.append(path)
    if not paths:
        raise SystemExit("Expected at least one docs page with marimo configuration")
    return paths


def publish_wheel(wheel: Path, local_requirement: str, base_url: str) -> Path:
    digest = wheel_sha256(wheel)
    destination = DOCS_HTML_DIR.joinpath(
        *PUBLIC_WHEEL_PATH.parts,
        digest,
        wheel.name,
    )
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(wheel, destination)

    public_reference = (
        f"{base_url}/{PUBLIC_WHEEL_PATH.as_posix()}/"
        f"{digest}/{wheel.name}#sha256={digest}"
    )
    public_requirement = requirement(public_reference)
    replacement_count = rewrite_site_dependency(
        local_requirement,
        public_requirement,
    )
    if destination.read_bytes() != wheel.read_bytes():
        raise SystemExit(f"Published wheel differs from {wheel}")
    assert_site_dependencies(local_requirement, public_requirement)
    print(f"published {destination} ({replacement_count} references)")
    return destination


def rewrite_site_dependency(old: str, new: str) -> int:
    replacement_count = rewrite_site_text(old, new)
    if not replacement_count:
        raise SystemExit("Expected generated docs with a local wheel dependency")
    return replacement_count


def rewrite_site_text(old: str, new: str) -> int:
    replacement_count = 0
    for path in site_text_files():
        source = path.read_text(encoding="utf-8")
        count = source.count(old)
        if not count:
            continue
        path.write_text(source.replace(old, new), encoding="utf-8")
        replacement_count += count
    return replacement_count


def install_same_origin_requirement_resolver() -> None:
    bridges = sorted(DOCS_HTML_DIR.glob("build/container-widget-*.mjs"))
    if len(bridges) != 1:
        raise SystemExit(f"Expected one generated marimo bridge, found {len(bridges)}")

    bridge = bridges[0]
    source = bridge.read_text(encoding="utf-8")
    if source.count(BRIDGE_NOTEBOOK_CODE_ASSIGNMENT) != 1:
        raise SystemExit("Generated marimo bridge has an unexpected notebook model")
    if source.count(BRIDGE_MODEL_READER) != 1:
        raise SystemExit("Generated marimo bridge has an unexpected model reader")
    if source.count(BRIDGE_MOLAB_NOTEBOOK_CODE_ASSIGNMENT) != 1:
        raise SystemExit("Generated marimo bridge has an unexpected molab model")

    updated = (
        source.replace(
            BRIDGE_NOTEBOOK_CODE_ASSIGNMENT,
            BRIDGE_NOTEBOOK_CODE_REPLACEMENT,
        )
        .replace(
            BRIDGE_MOLAB_NOTEBOOK_CODE_ASSIGNMENT,
            BRIDGE_MOLAB_NOTEBOOK_CODE_REPLACEMENT,
        )
        .replace(
            BRIDGE_MODEL_READER,
            f"{BRIDGE_REQUIREMENT_RESOLVER}{BRIDGE_MODEL_READER}",
        )
    )
    digest = hashlib.sha256(updated.encode()).hexdigest()[:32]
    destination = bridge.with_name(f"container-widget-{digest}.mjs")
    destination.write_text(updated, encoding="utf-8")
    run(["node", "--check", str(destination)])
    replacement_count = rewrite_site_text(bridge.name, destination.name)
    if not replacement_count:
        destination.unlink()
        raise SystemExit("Generated docs do not reference the marimo bridge")
    if bridge != destination:
        bridge.unlink()
    print(f"prepared {destination} ({replacement_count} references)")


def assert_source_dependencies() -> None:
    for path in interactive_docs():
        source = path.read_text(encoding="utf-8")
        if "pyobservablejs @" in source:
            raise SystemExit(f"Source docs must keep the package dependency: {path}")


def assert_site_dependencies(local: str, public: str) -> None:
    public_count = 0
    local_failures: list[str] = []
    unexpected_failures: list[str] = []
    for path in site_text_files():
        source = path.read_text(encoding="utf-8")
        if local in source or "../dist/docs/" in source:
            local_failures.append(str(path))
        if source.count("pyobservablejs @ ") != source.count(public):
            unexpected_failures.append(str(path))
        public_count += source.count(public)
    if local_failures:
        details = "\n".join(local_failures[:20])
        raise SystemExit(f"Generated docs contain local wheel references:\n{details}")
    if unexpected_failures:
        details = "\n".join(unexpected_failures[:20])
        raise SystemExit(
            f"Generated docs contain unexpected wheel references:\n{details}"
        )
    if not public_count:
        raise SystemExit("Generated docs lack the published wheel dependency")


def configured_base_url(value: str | None = None) -> str:
    raw = os.environ.get("BASE_URL", "") if value is None else value
    parsed = urlsplit(raw)
    if (
        raw != raw.strip()
        or parsed.scheme
        or parsed.netloc
        or parsed.query
        or parsed.fragment
        or "\\" in raw
        or "%" in raw
    ):
        raise SystemExit(
            "BASE_URL must be a plain absolute URL path without a host, query, or fragment"
        )
    if raw in {"", "/"}:
        return ""
    if not raw.startswith("/") or raw.startswith("//"):
        raise SystemExit("BASE_URL must start with one slash")

    base_url = raw.rstrip("/")
    segments = base_url[1:].split("/")
    if any(
        part in {"", ".", ".."} or BASE_URL_SEGMENT.fullmatch(part) is None
        for part in segments
    ):
        raise SystemExit("BASE_URL must contain URL-safe, non-empty path segments")
    return base_url


@contextmanager
def docs_serve_root(base_url: str) -> Iterator[Path]:
    if not base_url:
        yield DOCS_HTML_DIR
        return

    with TemporaryDirectory(prefix="pyobservablejs-docs-") as temporary_directory:
        serve_root = Path(temporary_directory)
        mount = serve_root.joinpath(*base_url.removeprefix("/").split("/"))
        mount.parent.mkdir(parents=True, exist_ok=True)
        mount.symlink_to(DOCS_HTML_DIR, target_is_directory=True)
        yield serve_root


def site_text_files() -> list[Path]:
    if not DOCS_HTML_DIR.is_dir():
        raise SystemExit(f"Expected static docs directory: {DOCS_HTML_DIR}")
    return [
        path
        for path in DOCS_HTML_DIR.rglob("*")
        if path.is_file() and path.suffix in SITE_TEXT_SUFFIXES
    ]


def requirement(reference: str) -> str:
    return f"pyobservablejs @ {reference}"


def relative_reference(wheel: Path) -> str:
    reference_path = os.path.relpath(wheel.resolve(), DOCS_DIR.resolve())
    return Path(reference_path).as_posix()


def single_wheel(directory: Path) -> Path:
    wheels = sorted(directory.glob("pyobservablejs-*.whl"))
    if len(wheels) != 1:
        raise SystemExit(
            f"Expected one pyobservablejs wheel in {directory}, found {len(wheels)}"
        )
    return wheels[0]


def remove_tree(path: Path) -> None:
    if not path.exists() and not path.is_symlink():
        return
    shutil.rmtree(path)


def wheel_sha256(wheel: Path) -> str:
    hasher = hashlib.sha256()
    with wheel.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def check_docs_plugin() -> None:
    if shutil.which("jupyter-book-marimo") is None:
        raise SystemExit(
            "Jupyter Book marimo plugin is missing. "
            "Run `uv sync --group dev` before building docs."
        )


def run(
    command: list[str],
    *,
    cwd: Path = PROJECT_ROOT,
    env: dict[str, str] | None = None,
) -> None:
    print("+", " ".join(command), flush=True)
    subprocess.run(command, cwd=cwd, env=env, check=True)


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        raise SystemExit(error.returncode) from None
    except KeyboardInterrupt:
        raise SystemExit(130) from None
