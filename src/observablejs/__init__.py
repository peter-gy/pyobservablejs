"""Python API for embedding Observable JavaScript notebooks."""

from __future__ import annotations

import importlib.metadata

from ._graph import CellInfo, DependencyEdge, NotebookGraph
from ._notebook import Cell, NotebookCell, Notebook, cell, html, js, md, sql
from ._variables import arrow, records

try:
    __version__ = importlib.metadata.version("observablejs")
except importlib.metadata.PackageNotFoundError:
    __version__ = "unknown"

__all__ = [
    "Cell",
    "NotebookCell",
    "CellInfo",
    "DependencyEdge",
    "Notebook",
    "NotebookGraph",
    "arrow",
    "cell",
    "html",
    "js",
    "md",
    "records",
    "sql",
]
