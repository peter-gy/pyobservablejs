from __future__ import annotations

import subprocess
import sys
from importlib.metadata import version
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).parents[3]
VERIFY_RELEASE_SCRIPT = REPOSITORY_ROOT / "scripts" / "verify_release.py"


def run_verifier(expected_version: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(VERIFY_RELEASE_SCRIPT), expected_version],
        cwd=REPOSITORY_ROOT,
        check=False,
        capture_output=True,
        text=True,
    )


def test_verifier_accepts_installed_release() -> None:
    installed_version = version("pyobservablejs")

    result = run_verifier(installed_version)

    assert result.returncode == 0
    assert result.stdout == f"Verified pyobservablejs {installed_version}\n"
    assert result.stderr == ""


def test_verifier_rejects_another_release() -> None:
    installed_version = version("pyobservablejs")
    expected_version = "999.0.0"

    result = run_verifier(expected_version)

    assert result.returncode == 1
    assert result.stdout == ""
    assert result.stderr == (
        f"Installed pyobservablejs version {installed_version} does not match "
        f"release {expected_version}\n"
    )
