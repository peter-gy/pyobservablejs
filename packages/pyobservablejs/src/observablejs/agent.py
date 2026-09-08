"""Use pyobservablejs from notebook agents."""

from __future__ import annotations

import sys as _sys
from textwrap import indent as _indent
from types import ModuleType as _ModuleType

import agent_plugins as _agent_plugins

_DISTRIBUTION_NAME = "pyobservablejs"
_SKILL_NAME = "pyobservablejs"


def agent_plugin() -> _agent_plugins.Plugin:
    """Return the Agent Plugin installed with this pyobservablejs version."""
    return _agent_plugins.locate(_DISTRIBUTION_NAME)


def agent_skill() -> _agent_plugins.Skill:
    """Return the packaged authoring and inspection instructions.

    Read ``skill.body`` for the workflow and follow its host, diagnostic,
    authoring, and data references through ``skill.file(...)``.
    """
    return agent_plugin().skill(_SKILL_NAME)


def _module_help(summary: str) -> str:
    try:
        plugin = agent_plugin()
        skill = plugin.skill(_SKILL_NAME)
    except _agent_plugins.AgentPluginError as error:
        return f"{summary}\n\nPackaged agent instructions are unavailable: {error}\n"
    tree = _indent(plugin.tree(max_depth=3, max_files=50), "    ")
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

    {skill.file("SKILL.md")}

Traverse the same resources programmatically:

    import observablejs.agent as observablejs_agent

    resources = observablejs_agent.agent_plugin()
    skill = observablejs_agent.agent_skill()
    print(resources)
    print(skill.body)
    print(skill.file("references/diagnose.md").read_text(encoding="utf-8"))

Browse the published documentation map at:

    https://peter-gy.github.io/pyobservablejs/llms.txt
"""


__all__ = ["agent_plugin", "agent_skill"]


def __dir__() -> list[str]:
    return sorted(__all__)


class _AgentModule(_ModuleType):
    @property
    def __doc__(self) -> str | None:  # pyrefly: ignore [bad-override]
        summary = self.__dict__.get("__doc__")
        return _module_help(summary) if isinstance(summary, str) else None

    @__doc__.setter
    def __doc__(self, value: str | None) -> None:
        self.__dict__["__doc__"] = value


_sys.modules[__name__].__class__ = _AgentModule
