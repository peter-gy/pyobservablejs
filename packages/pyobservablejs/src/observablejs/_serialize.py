"""Serialize Python-authored notebooks to Observable Notebook Kit HTML."""

from __future__ import annotations

import html as _html
import re
from collections.abc import Mapping
from typing import Any, Literal

from ._themes import serialize_theme

Mode = Literal[
    "js",
    "ts",
    "ojs",
    "md",
    "html",
    "tex",
    "dot",
    "sql",
    "node",
    "python",
    "r",
]
RuntimeProfile = Literal["notebook-kit", "observable"]

RUNTIME_PROFILE_ATTRIBUTE = "data-pyobservablejs-runtime-profile"

SCRIPT_TYPES = {
    "js": "module",
    "ts": "text/x-typescript",
    "ojs": "application/vnd.observable.javascript",
    "md": "text/markdown",
    "html": "text/html",
    "tex": "application/x-tex",
    "dot": "text/vnd.graphviz",
    "sql": "application/sql",
    "node": "application/vnd.node.javascript",
    "python": "text/x-python",
    "r": "text/x-r",
}


def serialize(
    spec: Mapping[str, Any],
    *,
    runtime_profile: RuntimeProfile = "notebook-kit",
) -> str:
    """Render a Notebook Kit HTML document from the Python cell spec."""

    theme_value = serialize_theme(spec.get("theme", "air"))
    notebook_attrs = [f'theme="{_html.escape(theme_value, quote=True)}"']
    if runtime_profile == "observable":
        notebook_attrs.append(f'{RUNTIME_PROFILE_ATTRIBUTE}="observable"')
    parts = [
        "<!doctype html>",
        f"<notebook {' '.join(notebook_attrs)}>",
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
