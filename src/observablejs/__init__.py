"""Python API for embedding Observable JavaScript notebooks."""

from importlib.metadata import version as _version

from ._cells import Cell, html, js, md, ojs
from ._graph import CellInfo, DependencyEdge, NotebookGraph
from ._notebook import CellValues, Notebook, NotebookCell, NotRenderedError
from ._themes import NOTEBOOK_THEMES

__version__ = _version("pyobservablejs")

__all__ = [
    "NOTEBOOK_THEMES",
    "Cell",
    "CellInfo",
    "CellValues",
    "DependencyEdge",
    "Notebook",
    "NotebookCell",
    "NotebookGraph",
    "NotRenderedError",
    "html",
    "js",
    "md",
    "ojs",
]


def __dir__() -> list[str]:
    return sorted(__all__)
