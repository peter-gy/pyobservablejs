"""Python API for embedding Observable JavaScript notebooks."""

from __future__ import annotations

import importlib.metadata

from ._notebook import (
    Cell,
    Notebook,
    cell,
    html,
    md,
    module,
    sql,
)
from ._variables import arrow, records

try:
    __version__ = importlib.metadata.version("observablejs")
except importlib.metadata.PackageNotFoundError:
    __version__ = "unknown"

__all__ = [
    "Cell",
    "Notebook",
    "arrow",
    "cell",
    "html",
    "md",
    "module",
    "records",
    "sql",
]
