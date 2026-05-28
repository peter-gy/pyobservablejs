"""Python API for embedding Observable JavaScript notebooks."""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError as _PackageNotFoundError
from importlib.metadata import version as _version

from ._notebook import Notebook, html, js, md, ojs

try:
    __version__ = _version("pyobservablejs")
except _PackageNotFoundError:
    __version__ = "unknown"

__all__ = [
    "Notebook",
    "html",
    "js",
    "md",
    "ojs",
]
