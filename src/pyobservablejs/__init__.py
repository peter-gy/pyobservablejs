"""Python API for embedding Observable JavaScript notebooks."""

from __future__ import annotations

import importlib.metadata

from ._notebook import Notebook, html, js, md, ojs

try:
    __version__ = importlib.metadata.version("pyobservablejs")
except importlib.metadata.PackageNotFoundError:
    __version__ = "unknown"

__all__ = [
    "Notebook",
    "html",
    "js",
    "md",
    "ojs",
]
