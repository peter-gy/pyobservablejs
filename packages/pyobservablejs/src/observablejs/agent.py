"""Use pyobservablejs from notebook agents."""

from __future__ import annotations

import sys
from textwrap import indent
from types import ModuleType

import agent_plugins

_DISTRIBUTION_NAME = "pyobservablejs"
_SKILL_NAME = "pyobservablejs"


def agent_plugin() -> agent_plugins.Plugin:
    """Return the Agent Plugin installed with this pyobservablejs version."""
    return agent_plugins.locate(_DISTRIBUTION_NAME)


def _agent_skill(plugin: agent_plugins.Plugin) -> agent_plugins.Skill:
    for skill in plugin.skills:
        if skill.path.name == _SKILL_NAME:
            return skill
    raise agent_plugins.AgentPluginError(
        "The pyobservablejs Agent Plugin has no pyobservablejs skill. "
        "Reinstall pyobservablejs."
    )


def agent_skill() -> agent_plugins.Skill:
    """Return the packaged pyobservablejs Agent Skill."""
    return _agent_skill(agent_plugin())


def _module_help(summary: str) -> str:
    plugin = agent_plugin()
    skill = _agent_skill(plugin)
    tree = indent(plugin.tree(max_depth=3, max_files=50), "    ")
    return f"""{summary}

Start with the public notebook API:

    import observablejs as obs

    notebook = obs.Notebook(
        obs.ojs("answer = 40 + 2", key="answer"),
        obs.js('md`The answer is **${{answer}}**.`', key="summary"),
    )
    view = notebook.view()

The installed Agent Plugin carries the complete workflow and resources that
match this package version:

{tree}

Read the pyobservablejs skill instructions at:

    {skill / "SKILL.md"}

Traverse the same resources programmatically:

    import observablejs.agent as observablejs_agent

    resources = observablejs_agent.agent_plugin()
    skill = observablejs_agent.agent_skill()
    print(resources)
    print(skill.body)

Browse the published documentation map at:

    https://peter-gy.github.io/pyobservablejs/llms.txt
"""


__all__ = ["agent_plugin", "agent_skill"]


class _AgentModule(ModuleType):
    @property
    def __doc__(self) -> str | None:  # pyrefly: ignore [bad-override]
        summary = self.__dict__.get("__doc__")
        return _module_help(summary) if isinstance(summary, str) else None

    @__doc__.setter
    def __doc__(self, value: str | None) -> None:
        self.__dict__["__doc__"] = value


sys.modules[__name__].__class__ = _AgentModule
