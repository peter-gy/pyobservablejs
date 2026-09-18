"""Python notebook sessions, cell handles, and renderable views."""

from __future__ import annotations

import pathlib
import threading
from collections.abc import Iterable, Mapping, Sequence
from types import MappingProxyType
from typing import TYPE_CHECKING, Any, Self, Unpack, cast

import traitlets

from ._cells import Cell, NotebookCellInput
from ._controller import NotebookController
from ._inspection import NotebookInspection
from ._model import (
    NotebookModel,
    notebook_model_from_cells,
    notebook_model_from_html,
)
from ._observable_fetch import fetch_observablehq_document
from ._observable_model import notebook_model_from_observablehq_document
from ._serialize import RuntimeProfile
from ._variables import (
    deserialize_value,
    freeze_value,
)
from ._view import NotebookView
from ._view_options import (
    ResolvedNotebookViewOptions,
    resolve_notebook_view_options,
)
from ._widget_session import _NotebookSession
from .types import (
    CellSelector,
    FileInput,
    FileSnapshot,
    NotebookState,
    NotebookViewOptions,
    ObservableDocument,
    Theme,
    ThemeSnapshot,
)

if TYPE_CHECKING:
    from ._data import NotebookData
    from ._file_access import Files
    from ._namespaces import Cells, Graph, Render


def _wrap_marimo(instance: Any) -> Any:
    try:
        import marimo

        if marimo.running_in_notebook():
            return marimo.ui.anywidget(instance)
    except (ImportError, ModuleNotFoundError):
        pass
    return instance


class NotebookCell:
    """Canonical handle for one cell owned by a ``Notebook``."""

    __slots__ = ("_data", "_index", "_owner")
    _owner: Notebook
    _index: int
    _data: NotebookData

    def __init__(self) -> None:
        raise TypeError("NotebookCell objects are accessed through notebook.cells")

    @classmethod
    def _create(cls, notebook: Notebook, index: int) -> NotebookCell:
        cell = object.__new__(cls)
        cell._owner = notebook
        cell._index = index
        cell._data = notebook.data._scoped(index)
        return cell

    @property
    def index(self) -> int:
        """Zero-based position in the notebook definition."""

        return self._index

    @property
    def key(self) -> str | None:
        """Public cell identity, or ``None`` for an anonymous cell."""

        return self._owner._controller._cell_keys[self._index] or None

    @property
    def id(self) -> int:
        """Notebook Kit serialization identifier."""

        return self._owner._controller._cell_ids[self._index]

    @property
    def source(self) -> str:
        """Prepared Notebook Kit source for this cell."""

        return self._owner._nodes[self._index].value

    @property
    def mode(self) -> str:
        return self._owner._nodes[self._index].mode

    @property
    def hidden(self) -> bool:
        return self._owner._nodes[self._index].hidden

    @property
    def pinned(self) -> bool:
        return self._owner._nodes[self._index].pinned

    @property
    def output(self) -> str | None:
        return self._owner._nodes[self._index].output

    @property
    def database(self) -> str | None:
        return self._owner._nodes[self._index].database

    @property
    def data(self) -> NotebookData:
        return self._data


class Notebook(traitlets.HasTraits):
    """Notebook definition and Python-owned session state.

    ``state`` is a detached read-only snapshot. Observe that trait in reactive
    environments and use the mutation methods to change variables or ``theme``.
    """

    state: NotebookState = cast(Any, traitlets.Any(read_only=True))

    def __init__(
        self,
        *cells: NotebookCellInput,
        title: str = "Untitled",
        theme: Theme = "air",
        files: Mapping[str, FileInput] | None = None,
        base_path: str | pathlib.Path | None = None,
        variables: Mapping[str, object] | None = None,
        show_pinned_source: bool = False,
    ) -> None:
        """Create a notebook from Python-authored cells."""

        model = notebook_model_from_cells(
            cells,
            title=title,
            theme=theme,
            files=files,
            base_path=base_path,
        )
        self._initialize_model(
            model,
            variables=variables,
            show_pinned_source=show_pinned_source,
        )

    @classmethod
    def _from_model(
        cls,
        model: NotebookModel,
        *,
        variables: Mapping[str, object] | None,
        show_pinned_source: bool,
    ) -> Notebook:
        notebook = cls.__new__(cls)
        notebook._initialize_model(
            model,
            variables=variables,
            show_pinned_source=show_pinned_source,
        )
        return notebook

    def _initialize_model(
        self,
        model: NotebookModel,
        *,
        variables: Mapping[str, object] | None,
        show_pinned_source: bool,
    ) -> None:
        traitlets.HasTraits.__init__(self)
        self._model = model
        self._analysis_cache: NotebookInspection | None = None
        self._nodes = model.nodes
        self._runtime_profile = model.runtime_profile
        self._source_document: Mapping[str, object] | None = None
        self._cell_cache: dict[int, NotebookCell] = {}
        self._cell_lock = threading.Lock()
        self._controller = NotebookController(
            model,
            variables=variables,
            show_pinned_source=show_pinned_source,
        )
        from ._data import NotebookData
        from ._file_access import Files
        from ._namespaces import Cells, Graph, Render

        self._cells = Cells(self)
        self._files = Files(self)
        self._data = NotebookData(self)
        self._graph = Graph(self)
        self._render = Render(self)
        self._session: _NotebookSession | None = None
        self._publish_state()

    def _publish_state(self) -> None:
        variables = deserialize_value(self._controller._variables)
        snapshot = NotebookState(
            variables=cast(Mapping[str, object], freeze_value(variables)),
            attachments=cast(
                Mapping[str, FileSnapshot],
                freeze_value(dict(self._controller._attachments)),
            ),
            theme=cast(ThemeSnapshot, freeze_value(self._controller.theme)),
        )
        self.set_trait("state", snapshot)

    def _publish_variables(self, names: Iterable[str] | None = None) -> None:
        previous = self.state
        wire = self._controller._variables
        if names is None:
            variables = freeze_value(deserialize_value(wire))
        else:
            values = dict(previous.variables)
            for name in names:
                if name in wire:
                    values[name] = freeze_value(deserialize_value(wire[name]))
                else:
                    values.pop(name, None)
            variables = MappingProxyType(values)
        self.set_trait(
            "state", NotebookState(variables, previous.attachments, previous.theme)
        )

    @property
    def runtime_profile(self) -> RuntimeProfile:
        """The Notebook Kit or classic Observable runtime used by this notebook."""

        return self._runtime_profile

    @property
    def source_document(self) -> Mapping[str, object] | None:
        """Detached original Observable document, or ``None`` for other sources.

        This snapshot retains original nodes, data operations, and provenance.
        ``NotebookCell.source`` contains the prepared Notebook Kit cell source.
        """

        return self._source_document

    @property
    def variables(self) -> Mapping[str, object]:
        """Detached read-only snapshot of Python-owned variables.

        Initially empty unless ``variables`` were supplied. Use
        ``data.names()`` to list notebook definitions and ``data[name]`` to
        read their evaluated values.

        Mutating construction inputs does not change the session. The snapshot
        cannot update the notebook. Use ``update_variables``,
        ``replace_variables``, or ``reset_variables`` for writes and observe
        ``state`` in reactive environments.
        """

        return self.state.variables

    @property
    def theme(self) -> ThemeSnapshot:
        """Immutable snapshot of the Notebook Kit theme.

        Mutating construction inputs does not change the session. Assign this
        property to update the notebook and observe ``state`` in reactive
        environments.
        """

        return self.state.theme

    @theme.setter
    def theme(self, value: Theme) -> None:
        previous = self._controller.theme
        self._controller.theme = value
        if previous != self._controller.theme:
            self._analysis_cache = None
            self.set_trait(
                "state",
                NotebookState(
                    self.state.variables,
                    self.state.attachments,
                    freeze_value(self._controller.theme),
                ),
            )

    def update_variables(
        self,
        values: Mapping[str, object],
        /,
    ) -> None:
        """Merge Python-owned variable updates into every active view."""

        if self._controller.update_variables(values):
            self._publish_variables(self._controller._variable_update["values"])

    def replace_variables(
        self,
        values: Mapping[str, object],
        /,
    ) -> None:
        """Replace the Python-owned variable environment for every active view."""

        if self._controller.replace_variables(values):
            self._publish_variables()

    def reset_variables(self, *names: str) -> None:
        """Release Python ownership of variables in every active view."""

        if self._controller.reset_variables(*names):
            self._publish_variables(names)

    @property
    def cells(self) -> Cells:
        return self._cells

    @property
    def files(self) -> Files:
        return self._files

    @property
    def data(self) -> NotebookData:
        return self._data

    @property
    def graph(self) -> Graph:
        return self._graph

    @property
    def render(self) -> Render:
        return self._render

    def _cell_at(self, index: int) -> NotebookCell:
        with self._cell_lock:
            cached = self._cell_cache.get(index)
            if cached is None:
                cached = NotebookCell._create(self, index)
                self._cell_cache[index] = cached
            return cached

    def view(
        self,
        *selectors: CellSelector,
        **options: Unpack[NotebookViewOptions],
    ) -> NotebookView:
        """Create one view for all cells or positional cell selectors.

        Selectors may be keys, keyed authored ``Cell`` objects, or
        ``NotebookCell`` handles from this notebook. Selected outputs render in
        notebook order. In a running marimo notebook, the returned UI element
        proxies the underlying ``NotebookView``.

        Use ``capture_state=False`` when the rendered output is all the caller
        needs. The view remains interactive while ``NotebookView.state`` stays
        at its initial value.
        """

        return self._create_view(selectors, resolve_notebook_view_options(options))

    def _create_view(
        self,
        selectors: Sequence[CellSelector],
        options: ResolvedNotebookViewOptions,
    ) -> NotebookView:
        self._controller._require_open()
        indexes = None if not selectors else self._normalize_view_cells(selectors)
        return _wrap_marimo(
            NotebookView._create(
                self,
                indexes,
                options=options,
            )
        )

    def _widget_session(self) -> _NotebookSession:
        self._controller._require_open()
        if self._session is None:
            self._session = _NotebookSession(self._controller)
        return self._session

    def with_variables(self, **variables: object) -> Notebook:
        """Return an independent notebook with merged Python bindings."""
        self._controller._require_open()
        notebook = Notebook._from_model(
            self._model,
            variables={**self._controller.variables, **variables},
            show_pinned_source=self._controller._options["show_source"],
        )
        notebook._source_document = self._source_document
        if not self._controller._source:
            notebook.theme = self._controller.theme
        return notebook

    def __enter__(self) -> Self:
        self._controller._require_open()
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def _normalize_view_cells(self, selectors: Sequence[CellSelector]) -> list[int]:
        indexes: list[int] = []
        for selection in selectors:
            if isinstance(selection, NotebookCell):
                if selection._owner is not self:
                    raise ValueError("NotebookCell belongs to another Notebook")
                index = selection.index
            elif isinstance(selection, Cell):
                if selection.key is None:
                    raise ValueError("authored cell selectors require a key")
                index = self.cells[selection.key].index
            elif isinstance(selection, str):
                index = self.cells[selection].index
            else:
                raise TypeError("cell selector must be a key, Cell, or NotebookCell")
            if index in indexes:
                raise ValueError("view selectors must identify distinct cells")
            indexes.append(index)
        return sorted(indexes)

    def close(self) -> None:
        """Close the session and every live view created from it."""

        self._cell_cache.clear()
        self._controller.close()
        if self._session is not None:
            self._session.close()

    @classmethod
    def from_html(
        cls,
        source: str,
        *,
        files: Mapping[str, FileInput] | None = None,
        base_path: str | pathlib.Path | None = None,
        embed_file_attachments: bool = False,
        rewrite_imports: bool = False,
        variables: Mapping[str, object] | None = None,
        show_pinned_source: bool = False,
    ) -> Notebook:
        """Create a notebook from Notebook Kit HTML text."""

        model = notebook_model_from_html(
            source,
            files=files,
            base_path=base_path,
            embed_file_attachments=embed_file_attachments,
            rewrite_imports=rewrite_imports,
        )
        return cls._from_model(
            model,
            variables=variables,
            show_pinned_source=show_pinned_source,
        )

    @classmethod
    def from_observablehq(
        cls,
        specifier: str,
        *,
        variables: Mapping[str, object] | None = None,
        files: Mapping[str, FileInput] | None = None,
        show_pinned_source: bool = False,
        timeout: float | None = 30,
    ) -> Notebook:
        """Fetch a public Observable notebook with its original cell languages."""

        document = fetch_observablehq_document(specifier, timeout=timeout)
        return cls.from_observablehq_document(
            document,
            files=files,
            variables=variables,
            show_pinned_source=show_pinned_source,
        )

    @classmethod
    def from_observablehq_document(
        cls,
        document: ObservableDocument,
        *,
        title: str | None = None,
        variables: Mapping[str, object] | None = None,
        files: Mapping[str, FileInput] | None = None,
        show_pinned_source: bool = False,
    ) -> Notebook:
        """Create a notebook from classic nodes or a native Notebook Kit model."""

        model = notebook_model_from_observablehq_document(
            document,
            title=title,
            files=files,
        )
        notebook = cls._from_model(
            model,
            variables=variables,
            show_pinned_source=show_pinned_source,
        )
        notebook._source_document = freeze_value(document)
        return notebook

    def to_notebook_html(self) -> str:
        """Return Notebook Kit HTML for saving or inspecting the definition."""

        return self._controller.to_notebook_html()
