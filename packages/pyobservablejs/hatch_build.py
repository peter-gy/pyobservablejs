from __future__ import annotations

from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface
from native_build import require_assets


class CustomBuildHook(BuildHookInterface):
    """Require the frontend artifacts that form the Python package boundary."""

    def initialize(self, version: str, build_data: dict[str, object]) -> None:
        require_assets(Path(self.root))
