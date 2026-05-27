"""Serialize Python-authored notebooks to Observable Notebook Kit HTML."""

from __future__ import annotations

import html as _html
import re
from collections.abc import Mapping
from typing import Any, Literal

AuthorMode = Literal[
    "js",
    "ojs",
    "md",
    "html",
]

Mode = Literal[
    "js",
    "ojs",
    "md",
    "html",
    "sql",
]

AUTHOR_MODES: frozenset[str] = frozenset(("js", "ojs", "md", "html"))

SCRIPT_TYPES = {
    "js": "module",
    "ojs": "application/vnd.observable.javascript",
    "md": "text/markdown",
    "html": "text/html",
    "sql": "application/sql",
}


def serialize(spec: Mapping[str, Any]) -> str:
    """Render a Notebook Kit HTML document from the Python cell spec."""

    theme = spec.get("theme", "air")
    if isinstance(theme, Mapping):
        theme_value = f"light-dark({theme['light']}, {theme['dark']})"
    else:
        theme_value = str(theme)
    parts = [
        "<!doctype html>",
        f'<notebook theme="{_html.escape(theme_value, quote=True)}">',
        f"  <title>{_html.escape(str(spec.get('title', 'Untitled')))}</title>",
    ]
    for item in spec.get("cells", []):
        parts.append(_serialize_cell(item))
    parts.append("</notebook>")
    return "\n".join(parts) + "\n"


def _serialize_cell(item: Mapping[str, Any]) -> str:
    mode = item.get("mode", "js")
    script_type = SCRIPT_TYPES.get(mode)
    if script_type is None:
        raise ValueError(f"Unsupported Observable cell mode: {mode!r}")
    attrs = [f'id="{int(item["id"])}"', f'type="{script_type}"']
    for key in ("pinned", "hidden"):
        if item.get(key):
            attrs.append(f'{key}=""')
    for key in ("database", "format", "name", "output"):
        value = item.get(key)
        if value is not None:
            attrs.append(f'{key}="{_html.escape(str(value), quote=True)}"')
    value = re.sub(r"</script", "<\\/script", str(item.get("value", "")), flags=re.I)
    indented = "\n".join(
        f"    {line}" if line.strip() else "" for line in value.splitlines()
    )
    return f"  <script {' '.join(attrs)}>\n{indented}\n  </script>"
