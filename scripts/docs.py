from __future__ import annotations

import argparse
from collections.abc import Iterator
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
from urllib.request import urlopen


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DOCS_DIR = PROJECT_ROOT / "docs"
DOCS_WHEEL_DIR = PROJECT_ROOT / "dist" / "docs"
DOCS_BUILD_DIR = DOCS_DIR / "_build"
DOCS_GENERATED_DIR = DOCS_DIR / ".jupyter-book-marimo"
DOCS_SITE_PUBLIC_DIR = DOCS_BUILD_DIR / "site" / "public"
DOCS_PLUGIN = "jupyter-book-marimo"

DEFAULT_PORT = 27331
PUBLIC_WHEEL_PATH = "pkg/py/pyobservablejs"
PUBLIC_WHEEL_BASE = f"/{PUBLIC_WHEEL_PATH}"

SOURCE_DEPENDENCY_PATTERN = re.compile(
    r'(?P<open>\\?")pyobservablejs(?: @ [^"\\]*pyobservablejs-[^"\\]+\.whl(?:#[^"\\]*)?)?(?P<close>\\?")'
)
WHEEL_DEPENDENCY_PATTERN = re.compile(
    r'(?P<open>\\?")pyobservablejs @ [^"\\]*pyobservablejs-[^"\\]+\.whl(?:#[^"\\]*)?(?P<close>\\?")'
)
DEPENDENCY_VALUE_PATTERN = re.compile(
    r'pyobservablejs @ [^"\\]*pyobservablejs-[^"\\]+\.whl(?:#[^"\\]*)?'
)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build and preview pyobservablejs docs."
    )
    subcommands = parser.add_subparsers(dest="command", required=True)

    build = subcommands.add_parser(
        "build", help="Build the deployable Jupyter Book site."
    )
    build.set_defaults(func=build_command)

    serve = subcommands.add_parser("serve", help="Build and serve the docs locally.")
    serve.add_argument("--port", type=int, default=DEFAULT_PORT)
    serve.set_defaults(func=serve_command)

    wheel = subcommands.add_parser("wheel", help="Build only the docs wheel.")
    wheel.set_defaults(func=wheel_command)

    args = parser.parse_args()
    args.func(args)


def build_command(args: argparse.Namespace) -> None:
    wheel = build_wheel()
    build_site(wheel, PUBLIC_WHEEL_BASE)


def serve_command(args: argparse.Namespace) -> None:
    wheel = build_wheel()
    build_site(wheel, PUBLIC_WHEEL_BASE)
    serve_site(wheel, port=args.port)


def wheel_command(_args: argparse.Namespace) -> None:
    build_wheel()


def build_wheel() -> Path:
    shutil.rmtree(DOCS_WHEEL_DIR, ignore_errors=True)
    DOCS_WHEEL_DIR.mkdir(parents=True, exist_ok=True)
    run(["uv", "build", "--wheel", "--out-dir", str(DOCS_WHEEL_DIR)])
    return single_wheel(DOCS_WHEEL_DIR)


def build_site(wheel: Path, public_base: str) -> None:
    check_docs_plugin()
    with source_build_references(wheel):
        shutil.rmtree(DOCS_BUILD_DIR, ignore_errors=True)
        shutil.rmtree(DOCS_GENERATED_DIR, ignore_errors=True)
        run(
            ["uv", "run", "jupyter", "book", "build", "--site", "--strict"],
            cwd=DOCS_DIR,
        )
    publish_wheel(wheel, public_base)
    assert_source_package_references()


def serve_site(wheel: Path, port: int) -> None:
    preview_base = f"http://localhost:{port}/{PUBLIC_WHEEL_PATH}"
    exit_code = 0
    last_signature: tuple[tuple[str, int, int], ...] | None = None
    with source_build_references(wheel):
        process = subprocess.Popen(
            ["uv", "run", "jupyter", "book", "start", "--port", str(port)],
            cwd=DOCS_DIR,
        )
        try:
            wait_for_server(f"http://localhost:{port}", process)
            while process.poll() is None:
                signature = generated_signature()
                if signature != last_signature:
                    publish_wheel(wheel, preview_base)
                    last_signature = generated_signature()
                time.sleep(1)
            exit_code = process.returncode or 0
        except KeyboardInterrupt:
            exit_code = 130
        finally:
            stop_process(process)
    publish_wheel(wheel, PUBLIC_WHEEL_BASE)
    if exit_code:
        raise SystemExit(exit_code)


def publish_wheel(wheel: Path, public_base: str) -> None:
    destination = copy_to_public(wheel, DOCS_SITE_PUBLIC_DIR, PUBLIC_WHEEL_PATH)
    print(f"copied {destination}")
    reference = deployed_reference(wheel, public_base)
    sync_generated_reference(wheel, reference)
    assert_site_wheel_references(wheel, reference)


@contextmanager
def source_build_references(wheel: Path) -> Iterator[None]:
    sync_source_reference(requirement(wheel, relative_reference(wheel)))
    try:
        yield
    finally:
        restore_source_reference()


def sync_source_reference(value: str) -> None:
    sync_expected_files(
        source_reference_counts(), value, pattern=SOURCE_DEPENDENCY_PATTERN
    )


def restore_source_reference() -> None:
    sync_source_reference("pyobservablejs")


def source_reference_counts() -> dict[Path, int]:
    counts: dict[Path, int] = {}
    for path in sorted(DOCS_DIR.rglob("*.md")):
        if is_docs_generated_path(path):
            continue
        count = len(SOURCE_DEPENDENCY_PATTERN.findall(path.read_text(encoding="utf-8")))
        if count:
            counts[path] = count
    return counts


def generated_content_reference_counts() -> dict[Path, int]:
    content_dir = DOCS_BUILD_DIR / "site" / "content"
    if not content_dir.is_dir():
        raise SystemExit(f"Expected generated docs content directory: {content_dir}")
    counts: dict[Path, int] = {}
    for path in sorted(content_dir.glob("*.json")):
        count = len(WHEEL_DEPENDENCY_PATTERN.findall(path.read_text(encoding="utf-8")))
        if count:
            counts[path] = count
    if not counts:
        raise SystemExit(
            "Expected generated docs content with pyobservablejs wheel references"
        )
    return counts


def generated_reference_counts() -> dict[Path, int]:
    site_dir = DOCS_BUILD_DIR / "site"
    if not site_dir.is_dir():
        raise SystemExit(f"Expected docs site directory: {site_dir}")
    counts: dict[Path, int] = {}
    for path in site_text_files(site_dir):
        count = len(WHEEL_DEPENDENCY_PATTERN.findall(path.read_text(encoding="utf-8")))
        if count:
            counts[path] = count
    if not counts:
        raise SystemExit("Expected generated docs with pyobservablejs wheel references")
    return counts


def is_docs_generated_path(path: Path) -> bool:
    parts = set(path.relative_to(DOCS_DIR).parts)
    return bool(parts & {"_build", "_site", ".jupyter-book-marimo"})


def assert_source_package_references() -> None:
    failures: list[str] = []
    for path, expected_count in source_reference_counts().items():
        if not path.is_file():
            failures.append(f"Expected docs dependency file: {path}")
            continue
        text = path.read_text(encoding="utf-8")
        matches = SOURCE_DEPENDENCY_PATTERN.findall(text)
        if len(matches) != expected_count:
            failures.append(
                f"Expected {expected_count} pyobservablejs dependency in "
                f"{path}, found {len(matches)}"
            )
        if DEPENDENCY_VALUE_PATTERN.search(text):
            failures.append(f"{path}: source dependency must stay as pyobservablejs")
    if failures:
        details = "\n".join(failures[:20])
        raise SystemExit(f"Invalid source docs dependency reference(s):\n{details}")


def sync_generated_reference(wheel: Path, reference: str) -> None:
    value = requirement(wheel, reference)
    sync_expected_files(
        generated_reference_counts(), value, pattern=WHEEL_DEPENDENCY_PATTERN
    )
    sync_public_exports(value, generated_content_reference_counts())


def requirement(wheel: Path, reference: str) -> str:
    if not wheel.is_file():
        raise SystemExit(f"Wheel does not exist: {wheel}")
    if wheel.suffix != ".whl":
        raise SystemExit(f"Expected a wheel file: {wheel}")
    return f"pyobservablejs @ {reference}"


def relative_reference(wheel: Path) -> str:
    reference_path = os.path.relpath(wheel.resolve(), DOCS_DIR.resolve())
    return Path(reference_path).as_posix()


def deployed_reference(wheel: Path, public_base: str) -> str:
    digest = wheel_sha256(wheel)
    return f"{public_base.rstrip('/')}/{digest}/{wheel.name}#sha256={digest}"


def sync_expected_files(
    reference_counts: dict[Path, int],
    requirement: str,
    *,
    pattern: re.Pattern[str],
) -> None:
    for path, expected_count in reference_counts.items():
        if sync_file(path, requirement, expected_count=expected_count, pattern=pattern):
            print(f"updated {path}")


def sync_public_exports(requirement: str, reference_counts: dict[Path, int]) -> None:
    expected_paths = current_public_export_paths(reference_counts)
    remove_stale_public_exports(expected_paths)
    for path in sorted(expected_paths):
        if sync_file(
            path, requirement, expected_count=1, pattern=WHEEL_DEPENDENCY_PATTERN
        ):
            print(f"updated {path}")


def current_public_export_paths(reference_counts: dict[Path, int]) -> set[Path]:
    public_dir = DOCS_BUILD_DIR / "site" / "public"
    paths: set[Path] = set()
    for content_path in reference_counts:
        if not content_path.is_file():
            raise SystemExit(f"Expected generated content file: {content_path}")
        data = json.loads(content_path.read_text(encoding="utf-8"))
        exports = data.get("frontmatter", {}).get("exports", [])
        urls = [
            item.get("url")
            for item in exports
            if isinstance(item, dict)
            and item.get("format") == "md"
            and isinstance(item.get("url"), str)
        ]
        if len(urls) != 1:
            raise SystemExit(
                f"Expected one markdown public export in {content_path}, found "
                f"{len(urls)}"
            )
        path = public_dir / urls[0].lstrip("/")
        if not path.is_file():
            raise SystemExit(f"Expected generated public export: {path}")
        paths.add(path)
    return paths


def remove_stale_public_exports(expected_paths: set[Path]) -> None:
    public_dir = DOCS_BUILD_DIR / "site" / "public"
    for path in sorted(public_dir.glob("*.md")):
        if path in expected_paths:
            continue
        if WHEEL_DEPENDENCY_PATTERN.search(path.read_text(encoding="utf-8")):
            path.unlink()
            print(f"removed stale {path}")


def sync_file(
    path: Path,
    requirement: str,
    *,
    expected_count: int,
    pattern: re.Pattern[str],
) -> bool:
    if not path.is_file():
        raise SystemExit(f"Expected docs wheel reference file: {path}")
    source = path.read_text(encoding="utf-8")
    match_count = len(pattern.findall(source))
    if match_count != expected_count:
        raise SystemExit(
            f"Expected {expected_count} pyobservablejs wheel reference(s) in "
            f"{path}, found {match_count}"
        )
    updated = pattern.sub(
        lambda match: f"{match.group('open')}{requirement}{match.group('close')}",
        source,
    )
    if updated == source:
        return False
    path.write_text(updated, encoding="utf-8")
    return True


def copy_to_public(wheel: Path, public_dir: Path, public_path: str) -> Path:
    digest = wheel_sha256(wheel)
    destination_dir = public_dir / public_path.strip("/") / digest
    destination_dir.mkdir(parents=True, exist_ok=True)
    destination = destination_dir / wheel.name
    shutil.copy2(wheel, destination)
    return destination


def assert_site_wheel_references(wheel: Path, reference: str) -> None:
    site_dir = DOCS_BUILD_DIR / "site"
    expected = requirement(wheel, reference)
    failures: list[str] = []
    for path in site_text_files(site_dir):
        text = path.read_text(encoding="utf-8")
        if "../dist/docs/" in text:
            failures.append(f"{path}: contains ../dist/docs/")
        if "file://" in text:
            failures.append(f"{path}: contains file://")
        for match in DEPENDENCY_VALUE_PATTERN.finditer(text):
            value = match.group(0)
            if value != expected:
                failures.append(f"{path}: {value}")
            elif "#sha256=" not in value:
                failures.append(f"{path}: wheel reference lacks sha256")
    if failures:
        details = "\n".join(failures[:20])
        raise SystemExit(f"Invalid generated docs wheel reference(s):\n{details}")


def site_text_files(site_dir: Path) -> list[Path]:
    if not site_dir.is_dir():
        raise SystemExit(f"Expected docs site directory: {site_dir}")
    paths: list[Path] = []
    for path in site_dir.rglob("*"):
        if path.is_file() and path.suffix in {".html", ".js", ".json", ".md"}:
            paths.append(path)
    return paths


def generated_signature() -> tuple[tuple[str, int, int], ...]:
    paths: list[Path] = []
    for path in generated_content_reference_counts():
        if path.exists():
            paths.append(path)
    public_dir = DOCS_BUILD_DIR / "site" / "public"
    if public_dir.is_dir():
        for path in public_dir.glob("*.md"):
            if WHEEL_DEPENDENCY_PATTERN.search(path.read_text(encoding="utf-8")):
                paths.append(path)
    signature: list[tuple[str, int, int]] = []
    for path in sorted(set(paths)):
        stat = path.stat()
        signature.append((str(path), stat.st_mtime_ns, stat.st_size))
    return tuple(signature)


def single_wheel(directory: Path) -> Path:
    wheels = sorted(directory.glob("pyobservablejs-*.whl"))
    if len(wheels) != 1:
        raise SystemExit(
            f"Expected one pyobservablejs wheel in {directory}, found {len(wheels)}"
        )
    return wheels[0]


def wheel_sha256(wheel: Path) -> str:
    hasher = hashlib.sha256()
    with wheel.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def check_docs_plugin() -> None:
    if shutil.which(DOCS_PLUGIN) is None:
        raise SystemExit(
            f"Jupyter Book marimo plugin is missing: {DOCS_PLUGIN}. "
            "Run `uv sync --group dev` before building docs."
        )


def wait_for_server(url: str, process: subprocess.Popen[bytes]) -> None:
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise SystemExit(process.returncode or 1)
        try:
            with urlopen(url, timeout=1):
                return
        except OSError:
            time.sleep(1)
    stop_process(process)
    raise SystemExit(f"Timed out waiting for {url}")


def stop_process(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def run(command: list[str], *, cwd: Path = PROJECT_ROOT) -> None:
    print("+", " ".join(command), flush=True)
    subprocess.run(command, cwd=cwd, check=True)


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        raise SystemExit(error.returncode) from None
