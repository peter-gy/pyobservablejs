"""Python API for embedding Observable JavaScript notebooks."""

from importlib.metadata import PackageNotFoundError as _PackageNotFoundError
from importlib.metadata import version as _version

from ._cells import html, js, md, ojs
from ._notebook import Notebook
from ._themes import NOTEBOOK_THEMES

globals().pop("annotations", None)

try:
    __version__ = _version("pyobservablejs")
except _PackageNotFoundError:
    __version__ = "unknown"

__all__ = [
    "NOTEBOOK_THEMES",
    "Notebook",
    "html",
    "js",
    "md",
    "ojs",
]
