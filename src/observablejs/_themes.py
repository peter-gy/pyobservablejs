"""Notebook Kit theme names and validation."""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any, Literal, TypeAlias, cast, get_args

NotebookTheme = Literal[
    "air",
    "coffee",
    "cotton",
    "deep-space",
    "glacier",
    "ink",
    "midnight",
    "near-midnight",
    "ocean-floor",
    "parchment",
    "slate",
    "stark",
    "sun-faded",
]

Theme: TypeAlias = NotebookTheme | dict[str, NotebookTheme]

NOTEBOOK_THEMES: tuple[NotebookTheme, ...] = get_args(NotebookTheme)

_THEME_NAMES = frozenset(NOTEBOOK_THEMES)
_LIGHT_DARK_RE = re.compile(r"^light-dark\(([\w-]+),\s*([\w-]+)\)$")


def normalize_theme(value: Any) -> Theme:
    """Return a validated Notebook Kit theme spec."""

    if isinstance(value, str):
        return _normalize_theme_name(value)
    if isinstance(value, Mapping):
        keys = set(value)
        if keys != {"light", "dark"}:
            raise ValueError("theme mapping must contain exactly 'light' and 'dark'")
        return {
            "light": _normalize_theme_name(value["light"]),
            "dark": _normalize_theme_name(value["dark"]),
        }
    raise TypeError(
        "theme must be a Notebook Kit theme name or a mapping with 'light' and 'dark'"
    )


def serialize_theme(value: Any) -> str:
    """Return the Notebook Kit HTML theme attribute value."""

    theme = normalize_theme(value)
    if isinstance(theme, Mapping):
        return f"light-dark({theme['light']}, {theme['dark']})"
    return theme


def deserialize_theme_attribute(value: str | None) -> Theme:
    """Parse the Notebook Kit HTML theme attribute."""

    theme = (value or "air").strip().lower()
    match = _LIGHT_DARK_RE.match(theme)
    if match:
        light, dark = match.groups()
        return {
            "light": _normalize_theme_name(light),
            "dark": _normalize_theme_name(dark),
        }
    return _normalize_theme_name(theme)


def _normalize_theme_name(value: Any) -> NotebookTheme:
    if not isinstance(value, str):
        raise TypeError("theme name must be a string")
    theme = value.strip().lower()
    if theme not in _THEME_NAMES:
        raise ValueError(f"Unsupported Notebook Kit theme: {value!r}")
    return cast(NotebookTheme, theme)
