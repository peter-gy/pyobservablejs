from __future__ import annotations

from pathlib import Path
from typing import cast

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class CustomBuildHook(BuildHookInterface):
    """Require the frontend artifacts that form the Python package boundary."""

    def initialize(self, version: str, build_data: dict[str, object]) -> None:
        # uv installs workspace members in editable mode during setup.
        # Distribution artifacts use Hatch's standard build version.
        if version == "editable":
            return

        if self.target_name == "sdist":
            # Hatch force-includes the workspace VCS ignore file after applying
            # sdist selection. Keep the archive limited to package-owned files.
            raw_force_include = build_data.get("force_include")
            if isinstance(raw_force_include, dict):
                force_include = cast(dict[str, str], raw_force_include)
                for source, target in tuple(force_include.items()):
                    if target == ".gitignore":
                        del force_include[source]

        static = Path(self.root, "src", "observablejs", "static")
        required = (
            static / "index.js",
            static / "anywidget.json",
            static / "chunks" / "app.js",
            static / "widget.css",
        )
        missing = [
            path.relative_to(self.root) for path in required if not path.is_file()
        ]
        if missing:
            details = "\n".join(f"  - {path}" for path in missing)
            raise RuntimeError(
                "Build the @pyobservablejs/python frontend before packaging:\n"
                f"{details}"
            )
