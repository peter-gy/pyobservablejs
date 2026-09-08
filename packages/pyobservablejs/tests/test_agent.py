from __future__ import annotations

import pydoc
from importlib.metadata import distribution

import agent_plugins
import marimo._code_mode as code_mode
import observablejs.agent as observablejs_agent
import pytest


def test_marimo_code_mode_discovers_the_pyobservablejs_capability() -> None:
    assert code_mode.capabilities()["pyobservablejs"] == "observablejs.agent"


def test_agent_capability_entry_point_loads_the_instruction_module() -> None:
    capabilities = [
        entry_point
        for entry_point in distribution("pyobservablejs").entry_points
        if entry_point.group == "marimo.agent.capability"
    ]

    assert [(entry.name, entry.value) for entry in capabilities] == [
        ("pyobservablejs", "observablejs.agent")
    ]
    assert capabilities[0].load() is observablejs_agent


def test_agent_plugin_exposes_the_packaged_pyobservablejs_skill() -> None:
    plugin = observablejs_agent.agent_plugin()
    skill = observablejs_agent.agent_skill()

    assert plugin.manifest.name == "pyobservablejs"
    assert skill == plugin.skill("pyobservablejs")
    assert skill.path.name == "pyobservablejs"
    assert skill.file("SKILL.md").is_file()
    assert skill.file("agents/openai.yaml").is_file()
    for name in ("workflows", "hosts", "diagnose", "data"):
        assert skill.file(f"references/{name}.md").is_file()
    assert skill.frontmatter.splitlines()[0] == "name: pyobservablejs"


def test_agent_module_help_points_to_installed_resources() -> None:
    plugin = observablejs_agent.agent_plugin()
    skill = observablejs_agent.agent_skill()
    rendered = pydoc.render_doc(observablejs_agent)

    assert str(plugin.path) in rendered
    assert str(skill.file("SKILL.md")) in rendered
    assert 'skill.file("references/diagnose.md")' in rendered
    assert "resources = observablejs_agent.agent_plugin()" in rendered
    assert "https://peter-gy.github.io/pyobservablejs/llms.txt" in rendered


def test_agent_help_remains_available_when_plugin_resources_are_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def missing_plugin() -> agent_plugins.Plugin:
        raise agent_plugins.AgentPluginError("Installed plugin files are missing")

    monkeypatch.setattr(observablejs_agent, "agent_plugin", missing_plugin)

    assert "Installed plugin files are missing" in pydoc.render_doc(observablejs_agent)
    with pytest.raises(agent_plugins.AgentPluginError, match="missing"):
        observablejs_agent.agent_skill()
