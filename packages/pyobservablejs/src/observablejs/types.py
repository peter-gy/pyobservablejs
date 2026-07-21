"""Public type contracts for pyobservablejs.

Import this module through ``observablejs.types`` when annotating advanced
inputs or synchronized state.
"""

from __future__ import annotations

import dataclasses
import pathlib
from collections.abc import Mapping, Sequence
from typing import (
    TYPE_CHECKING,
    Literal,
    TypeAlias,
    TypeVar,
    TypedDict,
    Union,
    overload,
)

if TYPE_CHECKING:
    from ._cells import Cell
    from ._graph import NotebookGraph
    from ._notebook import NotebookCell

CellMode: TypeAlias = Literal[
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
CellFormat: TypeAlias = Literal[
    "text",
    "blob",
    "buffer",
    "json",
    "csv",
    "tsv",
    "jpeg",
    "gif",
    "webp",
    "png",
    "arrow",
    "parquet",
    "html",
    "svg",
    "xml",
]
CellSelector: TypeAlias = Union[str, "Cell", "NotebookCell"]

NotebookTheme: TypeAlias = Literal[
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


class ThemePair(TypedDict):
    """Notebook Kit themes for light and dark color schemes."""

    light: NotebookTheme
    dark: NotebookTheme


Theme: TypeAlias = NotebookTheme | ThemePair
ThemeSnapshot: TypeAlias = (
    NotebookTheme | Mapping[Literal["light", "dark"], NotebookTheme]
)


class FileSpec(TypedDict, total=False):
    """Normalized browser file attachment metadata."""

    url: str
    path: str
    mimeType: str
    lastModified: int
    size: int


FileInput: TypeAlias = str | pathlib.Path | FileSpec


_DefaultT = TypeVar("_DefaultT")


class FileSnapshot(Mapping[str, str | int]):
    """Read-only normalized file record from ``Notebook.state``."""

    @overload
    def __getitem__(self, key: Literal["url", "path", "mimeType"]) -> str: ...

    @overload
    def __getitem__(self, key: Literal["lastModified", "size"]) -> int: ...

    @overload
    def __getitem__(self, key: str) -> str | int: ...

    def __getitem__(self, key: str) -> str | int:
        raise NotImplementedError

    @overload
    def get(
        self, key: Literal["url", "path", "mimeType"], default: None = None, /
    ) -> str | None: ...

    @overload
    def get(
        self, key: Literal["url", "path", "mimeType"], default: _DefaultT, /
    ) -> str | _DefaultT: ...

    @overload
    def get(
        self, key: Literal["lastModified", "size"], default: None = None, /
    ) -> int | None: ...

    @overload
    def get(
        self, key: Literal["lastModified", "size"], default: _DefaultT, /
    ) -> int | _DefaultT: ...

    @overload
    def get(self, key: object, default: None = None, /) -> str | int | None: ...

    @overload
    def get(self, key: object, default: _DefaultT, /) -> str | int | _DefaultT: ...

    def get(
        self, key: object, default: _DefaultT | None = None, /
    ) -> str | int | _DefaultT | None:
        if not isinstance(key, str):
            return default
        try:
            return self[key]
        except KeyError:
            return default


class NotebookKitCellMetadata(TypedDict, total=False):
    """Mode-specific Notebook Kit cell metadata."""

    database: str
    format: CellFormat
    since: str | int | float


class ObservableSource(TypedDict, total=False):
    """Source record embedded in ObservableHQ node data."""

    name: str
    type: str
    dialect: str


class ObservableDisplay(TypedDict, total=False):
    """Display configuration embedded in ObservableHQ node data."""

    mode: str


class ObservableData(TypedDict, total=False):
    """Data configuration embedded in an ObservableHQ node."""

    source: ObservableSource
    operations: Mapping[str, object]
    config: Mapping[str, object]
    display: ObservableDisplay


class ObservableNode(TypedDict, total=False):
    """One node from the ObservableHQ document API."""

    id: int | str
    mode: str
    value: object
    name: str | None
    pinned: bool
    hidden: bool
    database: str
    format: str
    output: str
    data: ObservableData


class ObservableFile(TypedDict, total=False):
    """One file record from the ObservableHQ document API."""

    name: str
    download_url: str
    mime_type: str
    size: int
    create_time: str


class ObservableDocument(TypedDict, total=False):
    """ObservableHQ document API payload accepted by the constructor."""

    id: str
    version: int
    title: str
    nodes: Sequence[ObservableNode]
    files: Sequence[ObservableFile]


CellStatus: TypeAlias = Literal["pending", "success", "error"]
ErrorPhase: TypeAlias = Literal[
    "analysis",
    "evaluation",
    "rendering",
    "serialization",
]


@dataclasses.dataclass(frozen=True)
class BrowserErrorValue:
    """JavaScript ``Error`` returned as a successful cell value."""

    name: str
    message: str


@dataclasses.dataclass(frozen=True)
class CellError:
    """Structured failure produced while evaluating one cell output."""

    name: str
    message: str
    phase: ErrorPhase
    variable: str | None = None


@dataclasses.dataclass(frozen=True)
class ViewError:
    """Structured failure that prevented a view from evaluating cells."""

    name: str
    message: str
    phase: ErrorPhase


@dataclasses.dataclass(frozen=True)
class CellResult:
    """Result for one selected cell at an input revision."""

    cell: NotebookCell
    revision: int
    status: CellStatus
    values: Mapping[str, object]
    errors: tuple[CellError, ...] = ()


@dataclasses.dataclass(frozen=True)
class NotebookState:
    """Detached immutable snapshot of controller-owned notebook state."""

    variables: Mapping[str, object]
    attachments: Mapping[str, FileSnapshot]
    theme: ThemeSnapshot


@dataclasses.dataclass(frozen=True)
class ViewState:
    """Immutable snapshot of browser evaluation state."""

    input_revision: int | None = None
    settled_revision: int | None = None
    pending: bool = False
    results: tuple[CellResult, ...] = ()
    errors: tuple[ViewError, ...] = ()
    graph: NotebookGraph | None = None

    def result(self, selector: CellSelector) -> CellResult:
        """Return the selected-cell result identified by ``selector``."""

        from ._cells import Cell
        from ._notebook import NotebookCell

        if isinstance(selector, str):
            key = selector
            matches = [result for result in self.results if result.cell.key == key]
        elif isinstance(selector, Cell):
            if selector.key is None:
                raise ValueError("authored cell selectors require a key")
            matches = [
                result for result in self.results if result.cell.key == selector.key
            ]
        elif isinstance(selector, NotebookCell):
            if self.results and selector._owner is not self.results[0].cell._owner:
                raise ValueError("NotebookCell belongs to another Notebook")
            matches = [result for result in self.results if result.cell is selector]
        else:
            raise TypeError("cell selector must be a key, Cell, or NotebookCell")
        if not matches:
            raise KeyError(f"No result for cell selector: {selector!r}")
        if len(matches) > 1:
            raise KeyError(f"Ambiguous cell selector: {selector!r}")
        return matches[0]


__all__ = [
    "BrowserErrorValue",
    "CellError",
    "CellFormat",
    "CellMode",
    "CellResult",
    "CellSelector",
    "CellStatus",
    "ErrorPhase",
    "FileInput",
    "FileSnapshot",
    "FileSpec",
    "NotebookKitCellMetadata",
    "NotebookState",
    "NotebookTheme",
    "ObservableData",
    "ObservableDisplay",
    "ObservableDocument",
    "ObservableFile",
    "ObservableNode",
    "ObservableSource",
    "Theme",
    "ThemePair",
    "ThemeSnapshot",
    "ViewError",
    "ViewState",
]
