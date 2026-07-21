from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest


REPOSITORY_ROOT = Path(__file__).parents[3]
RELEASE_SCRIPT = REPOSITORY_ROOT / "scripts" / "release.sh"


def run_command(
    *args: str,
    cwd: Path,
    env: dict[str, str] | None = None,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        cwd=cwd,
        env=env,
        check=check,
        capture_output=True,
        text=True,
    )


@pytest.fixture
def release_repository(tmp_path: Path) -> tuple[Path, Path, dict[str, str]]:
    origin = tmp_path / "origin.git"
    repository = tmp_path / "repository"
    fake_bin = tmp_path / "bin"
    origin.mkdir()
    repository.mkdir()
    fake_bin.mkdir()

    run_command("git", "init", "--bare", cwd=origin)
    run_command("git", "init", "--initial-branch", "main", cwd=repository)
    run_command("git", "config", "user.name", "Release Test", cwd=repository)
    run_command("git", "config", "user.email", "release@example.test", cwd=repository)

    scripts = repository / "scripts"
    scripts.mkdir()
    shutil.copy2(RELEASE_SCRIPT, scripts / "release.sh")
    (repository / "README.md").write_text("release fixture\n")
    run_command("git", "add", ".", cwd=repository)
    run_command("git", "commit", "-m", "initial", cwd=repository)
    run_command("git", "remote", "add", "origin", str(origin), cwd=repository)
    run_command("git", "push", "-u", "origin", "main", cwd=repository)

    uv = fake_bin / "uv"
    uv.write_text("#!/usr/bin/env bash\nprintf '%s\\n' \"${FAKE_VERSION:-0.0.7}\"\n")
    uv.chmod(0o755)

    gh = fake_bin / "gh"
    gh.write_text(
        """#!/usr/bin/env bash
if [[ "$1 $2" == "run list" ]]; then
  printf '%s\\n' "${FAKE_CI_RUN:-123${FAKE_TAB}completed${FAKE_TAB}success${FAKE_TAB}https://example.test/actions/runs/123}"
elif [[ "$1 $2" == "repo view" ]]; then
  printf '%s\\n' 'https://github.com/example/pyobservablejs'
else
  printf 'unexpected gh invocation: %s\\n' "$*" >&2
  exit 1
fi
"""
    )
    gh.chmod(0o755)

    env = os.environ.copy()
    env.update(
        {
            "FAKE_TAB": "\t",
            "PATH": f"{fake_bin}{os.pathsep}{env['PATH']}",
        }
    )
    return repository, origin, env


def run_release(
    repository: Path,
    env: dict[str, str],
    *args: str,
) -> subprocess.CompletedProcess[str]:
    return run_command(
        str(repository / "scripts" / "release.sh"),
        *args,
        cwd=repository,
        env=env,
        check=False,
    )


def test_dry_run_reports_release_without_creating_tag(
    release_repository: tuple[Path, Path, dict[str, str]],
) -> None:
    repository, _origin, env = release_repository

    result = run_release(repository, env, "--dry-run")

    assert result.returncode == 0
    assert "Release: v0.0.7" in result.stdout
    assert "CI:      https://example.test/actions/runs/123" in result.stdout
    assert "Dry run complete" in result.stdout
    tags = run_command("git", "tag", "--list", cwd=repository).stdout
    assert tags == ""


def test_release_pushes_annotated_tag(
    release_repository: tuple[Path, Path, dict[str, str]],
) -> None:
    repository, origin, env = release_repository

    result = run_release(repository, env)

    assert result.returncode == 0
    assert "Release v0.0.7 started" in result.stdout
    assert "actions/workflows/publish.yml" in result.stdout
    local_type = run_command(
        "git", "cat-file", "-t", "refs/tags/v0.0.7", cwd=repository
    ).stdout.strip()
    remote_type = run_command(
        "git",
        f"--git-dir={origin}",
        "cat-file",
        "-t",
        "refs/tags/v0.0.7",
        cwd=repository,
    ).stdout.strip()
    assert local_type == "tag"
    assert remote_type == "tag"


def test_release_requires_clean_synchronized_main(
    release_repository: tuple[Path, Path, dict[str, str]],
) -> None:
    repository, _origin, env = release_repository
    (repository / "README.md").write_text("changed\n")

    dirty_result = run_release(repository, env, "--dry-run")

    assert dirty_result.returncode == 1
    assert "The working tree must be clean" in dirty_result.stderr

    run_command("git", "restore", "README.md", cwd=repository)
    (repository / "local.txt").write_text("local commit\n")
    run_command("git", "add", "local.txt", cwd=repository)
    run_command("git", "commit", "-m", "local", cwd=repository)

    diverged_result = run_release(repository, env, "--dry-run")

    assert diverged_result.returncode == 1
    assert "Local main must match origin/main" in diverged_result.stderr


def test_release_requires_successful_ci_for_current_commit(
    release_repository: tuple[Path, Path, dict[str, str]],
) -> None:
    repository, _origin, env = release_repository
    env["FAKE_CI_RUN"] = (
        "456\tcompleted\tfailure\thttps://example.test/actions/runs/456"
    )

    result = run_release(repository, env, "--dry-run")

    assert result.returncode == 1
    assert "Main CI must pass before releasing" in result.stderr
    assert "completed/failure" in result.stderr
    assert "gh run watch 456 --exit-status" in result.stderr


def test_release_rejects_existing_version_tag(
    release_repository: tuple[Path, Path, dict[str, str]],
) -> None:
    repository, _origin, env = release_repository
    run_command("git", "tag", "v0.0.7", cwd=repository)

    result = run_release(repository, env, "--dry-run")

    assert result.returncode == 1
    assert "Release tag already exists: v0.0.7" in result.stderr
