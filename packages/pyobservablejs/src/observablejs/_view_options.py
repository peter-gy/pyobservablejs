"""Validation and defaults for renderable view options."""

from __future__ import annotations

import dataclasses
from collections.abc import Mapping


@dataclasses.dataclass(frozen=True, slots=True)
class ResolvedNotebookViewOptions:
    """Validated options used while constructing a notebook view."""

    capture_state: bool


def resolve_notebook_view_options(
    options: Mapping[str, object],
) -> ResolvedNotebookViewOptions:
    """Validate public view options and apply their defaults."""

    for name in options:
        if name != "capture_state":
            raise TypeError(f"unexpected Notebook view option {name!r}")

    capture_state = options.get("capture_state", True)
    if not isinstance(capture_state, bool):
        raise TypeError("capture_state must be a boolean")
    return ResolvedNotebookViewOptions(capture_state=capture_state)
