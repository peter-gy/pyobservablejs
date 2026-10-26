"""Run the Python tests with each runtime dependency at its declared lower bound.

    python scripts/test_python_floors.py dist/floors/pyobservablejs-*.whl

The wheel installs on the minimum supported Python with every requirement of
`[project].dependencies` and the `chromium` extra pinned to its floor. The
marimo integration tests need current marimo, which raises those floors, so
they run in the regular test job.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TESTS = ROOT / "packages" / "pyobservablejs" / "tests"
FLOOR = re.compile(r"^(?P<name>[A-Za-z0-9_.-]+)>=(?P<version>[0-9][0-9A-Za-z.]*)$")


def floors() -> tuple[str, list[str]]:
    project = tomllib.loads(
        (ROOT / "packages" / "pyobservablejs" / "pyproject.toml").read_text()
    )["project"]
    pins = []
    for requirement in [
        *project["dependencies"],
        *project["optional-dependencies"]["chromium"],
    ]:
        match = FLOOR.match(requirement)
        if match is None:
            raise SystemExit(
                f"Runtime requirements must be plain floors: {requirement!r}"
            )
        pins.append(f"{match['name']}=={match['version']}")
    return project["requires-python"].removeprefix(">="), pins


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("wheel", type=Path)
    options = parser.parse_args()
    python, pins = floors()
    environment = [
        "uv",
        "run",
        "--no-project",
        "--isolated",
        "--python",
        python,
        "--with",
        str(options.wheel.resolve()),
        *(argument for pin in pins for argument in ("--with", pin)),
        *(
            argument
            for tool in ("pytest", "polars", "pandas", "pyarrow")
            for argument in ("--with", tool)
        ),
    ]
    install = ["python", "-m", "playwright", "install", "chromium", "--no-shell"]
    subprocess.run([*environment, *install], cwd=ROOT, check=True)
    tests = [
        "pytest",
        "-q",
        str(TESTS),
        f"--ignore={TESTS / 'test_agent.py'}",
        f"--ignore={TESTS / 'test_marimo.py'}",
    ]
    raise SystemExit(
        subprocess.run([*environment, *tests], cwd=ROOT, check=False).returncode
    )


if __name__ == "__main__":
    main()
