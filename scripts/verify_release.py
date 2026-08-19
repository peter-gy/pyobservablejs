from __future__ import annotations

import sys
from importlib.metadata import distribution
from importlib.metadata import version as distribution_version

import observablejs
import observablejs.agent as observablejs_agent
from observablejs import (
    NotebookView,
    view_from_code,
    view_from_html,
    view_from_observablehq,
    view_from_observablehq_document,
)


def verify_release(expected_version: str) -> None:
    installed_version = distribution_version("pyobservablejs")
    if installed_version != expected_version:
        raise SystemExit(
            f"Installed pyobservablejs version {installed_version} does not match "
            f"release {expected_version}"
        )

    if observablejs.__version__ != expected_version:
        raise SystemExit(
            f"observablejs.__version__ is {observablejs.__version__}, expected "
            f"{expected_version}"
        )

    factories = {
        "view_from_code": view_from_code,
        "view_from_html": view_from_html,
        "view_from_observablehq": view_from_observablehq,
        "view_from_observablehq_document": view_from_observablehq_document,
    }
    invalid_factories = [
        name for name, factory in factories.items() if not callable(factory)
    ]
    if invalid_factories:
        raise SystemExit(
            f"ObservableJS factories are not callable: {', '.join(invalid_factories)}"
        )

    view = view_from_code("answer = 42")
    try:
        if not isinstance(view, NotebookView):
            raise SystemExit(
                f"view_from_code returned {type(view).__name__}, expected NotebookView"
            )
    finally:
        view.close()

    agent_plugins_version = distribution_version("agent-plugins")
    if agent_plugins_version != "0.1.0":
        raise SystemExit(
            f"Installed agent-plugins version is {agent_plugins_version}, expected 0.1.0"
        )

    capabilities = [
        entry_point
        for entry_point in distribution("pyobservablejs").entry_points
        if entry_point.group == "marimo.agent.capability"
    ]
    capability_records = [(entry.name, entry.value) for entry in capabilities]
    if capability_records != [("pyobservablejs", "observablejs.agent")]:
        raise SystemExit(
            "Installed marimo capability is "
            f"{capability_records!r}, expected [('pyobservablejs', 'observablejs.agent')]"
        )
    if capabilities[0].load() is not observablejs_agent:
        raise SystemExit(
            "Installed pyobservablejs capability does not load observablejs.agent"
        )

    plugin = observablejs_agent.agent_plugin()
    if plugin.manifest.name != "pyobservablejs":
        raise SystemExit(
            "Installed Agent Plugin is "
            f"{plugin.manifest.name!r}, expected 'pyobservablejs'"
        )
    if plugin.manifest.issues:
        raise SystemExit(
            f"Installed Agent Plugin manifest issues: {plugin.manifest.issues!r}"
        )

    skill = observablejs_agent.agent_skill()
    if skill.path.name != "pyobservablejs":
        raise SystemExit("Installed pyobservablejs Agent Skill is unavailable")
    if (
        skill.frontmatter.splitlines()[0] != "name: pyobservablejs"
        or not skill.body.strip()
    ):
        raise SystemExit("Installed pyobservablejs Agent Skill is invalid")

    expected_plugin_files = {
        "plugin.json",
        "skills/pyobservablejs/SKILL.md",
        "skills/pyobservablejs/agents/openai.yaml",
        "skills/pyobservablejs/references/workflows.md",
    }
    plugin_files = {path.relative_to(plugin.path).as_posix() for path in plugin.files}
    if plugin_files != expected_plugin_files:
        raise SystemExit(
            "Installed Agent Plugin files are "
            f"{sorted(plugin_files)!r}, expected {sorted(expected_plugin_files)!r}"
        )


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python scripts/verify_release.py VERSION")

    expected_version = sys.argv[1]
    verify_release(expected_version)
    print(f"Verified pyobservablejs {expected_version}")


if __name__ == "__main__":
    main()
