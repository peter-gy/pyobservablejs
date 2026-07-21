"""Python API for embedding Observable JavaScript notebooks."""

from importlib.metadata import version as _version

from . import types
from ._cells import Cell, html, js, md, ojs
from ._factories import (
    view_from_code,
    view_from_html,
    view_from_observablehq,
    view_from_observablehq_document,
)
from ._graph import CellInfo, DependencyEdge, NotebookGraph
from ._notebook import Notebook, NotebookCell, NotebookView
from ._themes import NOTEBOOK_THEMES

__version__ = _version("pyobservablejs")

__all__ = [
    "NOTEBOOK_THEMES",
    "Cell",
    "CellInfo",
    "DependencyEdge",
    "Notebook",
    "NotebookCell",
    "NotebookView",
    "NotebookGraph",
    "html",
    "js",
    "md",
    "ojs",
    "types",
    "view_from_code",
    "view_from_html",
    "view_from_observablehq",
    "view_from_observablehq_document",
]


def __dir__() -> list[str]:
    return sorted(__all__)
