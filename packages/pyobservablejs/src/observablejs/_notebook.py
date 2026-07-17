"""Python widget models for Observable notebooks and cells."""

from __future__ import annotations

import dataclasses
import pathlib
import weakref
from collections.abc import Iterable, Mapping, Sequence
from typing import Any, cast

import anywidget
import traitlets
from anywidget_bundle import Bundle, BundledWidget

from ._cells import NotebookCellInput
from ._files import FileAttachment, FileInput
from ._graph import NotebookGraph, graph_from_raw
from ._model import (
    NotebookModel,
    notebook_model_from_cells,
    notebook_model_from_html,
    notebook_model_from_observablehq,
    notebook_model_from_observablehq_document,
    notebook_model_from_observablehq_nodes,
    notebook_model_from_observablehq_page_data,
)
from ._observable import (
    ObservableDocument,
    ObservableFilesInput,
    ObservableNodeInput,
    ObservablePageData,
)
from ._serialize import serialize
from ._themes import Theme, normalize_theme
from ._variables import (
    OBSERVABLE_RESERVED_VARIABLE_NAMES,
    deserialize_value,
    prepare_variables,
    same_wire_value,
    validate_variable_name,
    variable_updates_from_args,
)

_WIDGET_TRAIT = anywidget.WidgetTrait()
_WIDGET_TO_JSON = _WIDGET_TRAIT.metadata["to_json"]
_WIDGET_FROM_JSON = _WIDGET_TRAIT.metadata["from_json"]
_OBSERVABLE_WIDGET_STATIC_DIR = pathlib.Path(__file__).parent / "static"
_OBSERVABLE_WIDGET_DEV_SERVER_ENV = "OBSERVABLEJS_VITE_DEV_SERVER"
_OBSERVABLE_WIDGET_BUNDLE = Bundle(
    static_dir=_OBSERVABLE_WIDGET_STATIC_DIR,
    dev_server_env=_OBSERVABLE_WIDGET_DEV_SERVER_ENV,
)
_MISSING_VARIABLE = object()


def _require_sequence_container(value: object, *, message: str) -> None:
    if isinstance(value, str | bytes | bytearray) or not isinstance(value, Sequence):
        raise TypeError(message)


class NotRenderedError(RuntimeError):
    """Raised when browser-synchronized view state is read before render."""


@dataclasses.dataclass(frozen=True)
class CellValues:
    """Browser-synchronized values for one rendered cell."""

    index: int
    key: str | None
    values: dict[str, Any]


class _ObservableWidget(BundledWidget):
    """Shared anywidget base for the bundled frontend assets."""

    bundle = _OBSERVABLE_WIDGET_BUNDLE


class NotebookCell:
    """Stable selection handle for one Observable cell."""

    __slots__ = ("_notebook", "_index")

    def __init__(self, notebook: Notebook, index: int) -> None:
        self._notebook = notebook
        self._index = index

    @property
    def key(self) -> str:
        """Python handle assigned to this cell, or an empty string."""

        return self._notebook._cell_keys[self._index]

    @property
    def name(self) -> str:
        """Notebook Kit name assigned to this cell, or an empty string."""

        return self._notebook._cell_names[self._index]

    def view(self) -> NotebookView:
        """Create a display model that renders this cell."""

        return self._notebook.view([self])


class Notebook(_ObservableWidget):
    """State and runtime session for an Observable Notebook Kit notebook.

    Python owns cell specs, attachments, and Python-backed OJS variables. The
    browser resolves this session through a ``NotebookView`` display model.
    """

    role = traitlets.Unicode("session").tag(sync=True)
    _runtime_profile = traitlets.Enum(
        values=["notebook-kit", "observable"],
        default_value="notebook-kit",
    ).tag(sync=True)
    _source = traitlets.Unicode("").tag(sync=True)
    _spec = traitlets.Dict().tag(sync=True)
    theme = traitlets.Any(default_value="air").tag(sync=True)
    _attachments = traitlets.Dict().tag(sync=True)
    _base_url = traitlets.Unicode("").tag(sync=True)
    _variables = traitlets.Dict(default_value={}).tag(sync=True)
    _variable_update = traitlets.Dict(default_value={}).tag(sync=True)
    _view_values = traitlets.Dict(default_value={}).tag(sync=True)
    _options = traitlets.Dict().tag(sync=True)
    _cell_keys = traitlets.List(traitlets.Unicode(), default_value=[]).tag(sync=True)

    @traitlets.validate("theme")
    def _validate_theme(self, proposal: Any) -> Theme:
        self._require_open()
        theme = normalize_theme(proposal["value"])
        if (
            not getattr(self, "_initializing_notebook", False)
            and getattr(self, "_source", "")
            and theme != self.theme
        ):
            raise traitlets.TraitError(
                "source-backed notebook themes are defined by the source HTML"
            )
        return theme

    @traitlets.observe("theme")
    def _sync_theme_to_spec(self, change: Any) -> None:
        if getattr(self, "_initializing_notebook", False) or self._source:
            return
        spec = dict(self._spec)
        spec["theme"] = change["new"]
        self.set_trait("_spec", spec)

    def __init__(
        self,
        *cells: NotebookCellInput,
        title: str = "Untitled",
        theme: str | Mapping[str, str] = "air",
        files: Mapping[str, FileInput] | None = None,
        base_path: str | pathlib.Path | None = None,
        variables: Mapping[str, Any] | None = None,
        show_pinned_source: bool = False,
    ) -> None:
        """Create a notebook from Python-authored cells.

        Cells must come from ``obs.ojs``, ``obs.js``, ``obs.md``, or
        ``obs.html``. ``files`` registers file values, with ``base_path``
        resolving relative local paths. ``variables`` sets Python-owned OJS
        variables. ``show_pinned_source`` renders source for pinned cells.

        Raises:
            ValueError: ``mode`` or a variable name is invalid.
            TypeError: A cell or variable value is unsupported.
            FileNotFoundError: An explicit local attachment path does not exist.
            OSError: An explicit local attachment path cannot be read.
        """

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
        variables: Mapping[str, Any] | None,
        show_pinned_source: bool,
    ) -> "Notebook":
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
        variables: Mapping[str, Any] | None,
        show_pinned_source: bool,
    ) -> None:
        self._reserved_variable_names = (
            OBSERVABLE_RESERVED_VARIABLE_NAMES
            if model.runtime_profile == "observable"
            else frozenset()
        )
        self._variable_values, variable_wire = self._prepare_variables(variables)
        self._cell_names = tuple(model.cell_names)
        self._cell_cache: dict[int, NotebookCell] = {}
        self._views: weakref.WeakSet[NotebookView] = weakref.WeakSet()
        self._notebook_closed = False
        spec = dict(model.spec)
        if not model.source:
            spec["theme"] = model.theme
        options: dict[str, Any] = {"show_source": show_pinned_source}
        self._variable_update_seq = 0
        self._initializing_notebook = True
        try:
            super().__init__(
                _runtime_profile=model.runtime_profile,
                _source=model.source,
                _spec=spec,
                theme=model.theme,
                _attachments=dict(model.attachments),
                _variables=variable_wire,
                _options=options,
                _cell_keys=list(model.cell_keys),
            )
        finally:
            self._initializing_notebook = False

    @property
    def variables(self) -> dict[str, Any]:
        """Current Python-owned Observable variables."""

        return dict(self._variable_values)

    @property
    def source(self) -> str:
        """Notebook Kit source HTML for source-backed notebooks."""

        return self._source

    @property
    def spec(self) -> dict[str, Any]:
        """Notebook Kit spec for Python-authored notebooks."""

        return dict(self._spec)

    @property
    def attachments(self) -> dict[str, FileAttachment]:
        """File records sent to the frontend FileAttachment registry."""

        return cast(dict[str, FileAttachment], dict(self._attachments))

    @property
    def base_url(self) -> str:
        """Base URL used by the frontend for unresolved file references."""

        return self._base_url

    @property
    def options(self) -> dict[str, Any]:
        """Display options sent to the frontend renderer."""

        return dict(self._options)

    def update_variables(
        self,
        values: Mapping[str, Any] | Iterable[tuple[str, Any]] | None = None,
        /,
        **kwargs: Any,
    ) -> None:
        """Merge Python-owned variable updates into the live runtime.

        Accepts a mapping, key/value pairs, keyword arguments, or both. Nonempty
        updates set ``_variable_update`` with kind ``"set"`` and refresh the
        serialized ``_variables`` trait.
        """

        self._require_open()
        updates = variable_updates_from_args("update_variables", values, kwargs)
        if updates:
            self._patch_variables(updates)

    def replace_variables(
        self,
        values: Mapping[str, Any] | Iterable[tuple[str, Any]] | None = None,
        /,
        **kwargs: Any,
    ) -> None:
        """Replace the full Python-owned variable environment.

        Accepts a mapping, key/value pairs, keyword arguments, or both. Omitted
        names are released. The browser receives a replacement update and
        rebuilds the runtime so original notebook definitions return for
        released names.
        """

        self._require_open()
        replacement = variable_updates_from_args("replace_variables", values, kwargs)
        prepared, serialized = self._prepare_variables(replacement)
        self._apply_variable_replacement(prepared, serialized)

    def reset_variables(self, *names: str) -> None:
        """Release Python ownership for names that are currently overridden.

        Empty calls and missing names are no-ops. Removing at least one name
        sends a replacement update and restores original notebook definitions in
        the browser runtime.
        """

        self._require_open()
        if not names:
            return
        validated_names = tuple(self._validate_variable_name(name) for name in names)
        values = dict(self._variable_values)
        serialized = dict(self._variables)
        changed = False
        for name in validated_names:
            if name in values:
                del values[name]
                serialized.pop(name, None)
                changed = True
        if changed:
            self._apply_variable_replacement(
                values,
                serialized,
            )

    def _require_open(self) -> None:
        if self._notebook_closed:
            raise RuntimeError("Cannot mutate a closed Notebook")

    def _patch_variables(self, updates: Mapping[str, Any]) -> None:
        prepared_updates, serialized_updates = self._prepare_variables(updates)
        cleared_view_names = self._clear_view_values(serialized_updates)
        changed = {
            name: value
            for name, value in prepared_updates.items()
            if name in cleared_view_names
            or not same_wire_value(
                self._variables.get(name, _MISSING_VARIABLE), serialized_updates[name]
            )
        }
        if not changed:
            return
        changed_wire = {name: serialized_updates[name] for name in changed}
        self._variable_values = {**self._variable_values, **changed}
        self._variable_update_seq += 1
        self.set_trait(
            "_variable_update",
            {
                "seq": self._variable_update_seq,
                "kind": "set",
                "values": changed_wire,
            },
        )
        self.set_trait("_variables", {**self._variables, **changed_wire})

    def _prepare_variables(
        self, values: Mapping[str, Any] | None
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        return prepare_variables(values, reserved_names=self._reserved_variable_names)

    def _validate_variable_name(self, name: object) -> str:
        return validate_variable_name(
            name,
            reserved_names=self._reserved_variable_names,
        )

    def _apply_variable_replacement(
        self,
        values: Mapping[str, Any],
        serialized: Mapping[str, Any],
    ) -> None:
        python_names = set(self._variable_values).union(serialized)
        cleared_view_names = self._clear_view_values(python_names)
        if same_wire_value(self._variables, serialized) and not cleared_view_names:
            return
        self._variable_values = dict(values)
        wire = dict(serialized)
        self._variable_update_seq += 1
        self.set_trait(
            "_variable_update",
            {
                "seq": self._variable_update_seq,
                "kind": "replace",
                "values": wire,
            },
        )
        self.set_trait("_variables", wire)

    def _clear_view_values(self, names: Iterable[str]) -> set[str]:
        cleared_names = set(names).intersection(self._view_values)
        if cleared_names:
            self.set_trait(
                "_view_values",
                {
                    name: value
                    for name, value in self._view_values.items()
                    if name not in cleared_names
                },
            )
        return cleared_names

    @property
    def cells(self) -> tuple[NotebookCell, ...]:
        """Cell selection handles in notebook order."""

        return tuple(self.cell_at(index) for index in range(len(self._cell_keys)))

    def cell_at(self, index: int) -> NotebookCell:
        """Return the cell handle at zero-based notebook order."""

        count = len(self._cell_keys)
        normalized = index if index >= 0 else count + index
        if normalized < 0 or normalized >= count:
            raise IndexError("notebook cell index out of range")
        cached = self._cell_cache.get(normalized)
        if cached is not None:
            return cached
        cell = NotebookCell(self, normalized)
        self._cell_cache[normalized] = cell
        return cell

    def view(
        self,
        cells: Sequence[int | str | NotebookCell] | None = None,
    ) -> NotebookView:
        """Create a display model for the full notebook or selected cells.

        ``None`` selects the full notebook. Integer selections use notebook order,
        strings use Python cell keys, and ``NotebookCell`` selections must belong
        to this notebook. Explicit selections render in canonical notebook order.
        """

        if self._notebook_closed:
            raise RuntimeError("Cannot create a view from a closed Notebook")
        indexes = None if cells is None else self._normalize_view_cells(cells)
        return NotebookView(
            notebook=self,
            cell_indexes=indexes,
        )

    def _normalize_view_cells(
        self, cells: Sequence[int | str | NotebookCell]
    ) -> list[int]:
        _require_sequence_container(
            cells,
            message=(
                "view cells must be a sequence of indexes, keys, or "
                "NotebookCell objects"
            ),
        )
        if len(cells) == 0:
            raise ValueError("view cells must contain at least one selection")
        indexes: list[int] = []
        for selection in cells:
            if isinstance(selection, NotebookCell):
                if selection._notebook is not self:
                    raise ValueError("NotebookCell belongs to another Notebook")
                index = selection._index
            elif isinstance(selection, str):
                index = self.cell_by_key(selection)._index
            elif isinstance(selection, int) and not isinstance(selection, bool):
                index = self.cell_at(selection)._index
            else:
                raise TypeError(
                    "view cells must contain indexes, keys, or NotebookCell objects"
                )
            if index in indexes:
                raise ValueError("view cells must select each notebook cell once")
            indexes.append(index)
        return sorted(indexes)

    def cell_by_key(self, key: str) -> NotebookCell:
        """Return the unique cell handle with Python key ``key``."""

        matches = [index for index, item in enumerate(self._cell_keys) if item == key]
        if len(matches) == 1:
            return self.cell_at(matches[0])
        if len(matches) > 1:
            raise KeyError(f"Ambiguous Observable cell key: {key!r}")
        raise KeyError(f"Unknown Observable cell key: {key!r}")

    def close(self) -> None:
        """Close the session and its live display models."""

        if getattr(self, "_notebook_closed", False):
            return
        self._notebook_closed = True
        cache = getattr(self, "_cell_cache", None)
        if cache is not None:
            cache.clear()
        for view in tuple(getattr(self, "_views", ())):
            view.close()
        super().close()

    @classmethod
    def from_html(
        cls,
        source: str,
        *,
        files: Mapping[str, FileInput] | None = None,
        base_path: str | pathlib.Path | None = None,
        embed_file_attachments: bool = False,
        rewrite_imports: bool = False,
        variables: Mapping[str, Any] | None = None,
        show_pinned_source: bool = False,
    ) -> "Notebook":
        """Create a source-backed notebook from a Notebook Kit HTML string.

        ``embed_file_attachments`` discovers and embeds local file references.
        ``rewrite_imports`` rewrites relative JavaScript imports to data URLs.
        Either option requires ``base_path``. Explicit ``files`` override
        discovered files with the same name. ``variables`` sets Python-owned OJS
        variables for the rendered notebook.
        """

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
        variables: Mapping[str, Any] | None = None,
        files: Mapping[str, FileInput] | None = None,
        show_pinned_source: bool = False,
        timeout: float | None = 30,
    ) -> "Notebook":
        """Fetch a public ObservableHQ notebook through the document API.

        ``specifier`` may be an ObservableHQ URL, slug, id, or document API URL.
        ObservableHQ API ``js`` cells are imported as OJS cells. Remote uploaded
        files become URL-backed attachments. ``timeout`` controls the network
        request. Invalid specifiers or non-JSON responses raise ``ValueError``.
        HTTP and network failures raise ``OSError``.
        """

        model = notebook_model_from_observablehq(
            specifier,
            files=files,
            timeout=timeout,
        )
        return cls._from_model(
            model,
            variables=variables,
            show_pinned_source=show_pinned_source,
        )

    @classmethod
    def from_observablehq_document(
        cls,
        document: ObservableDocument | Mapping[str, Any],
        *,
        title: str | None = None,
        variables: Mapping[str, Any] | None = None,
        files: Mapping[str, FileInput] | None = None,
        show_pinned_source: bool = False,
    ) -> "Notebook":
        """Create a notebook from an ObservableHQ document API mapping.

        ``document`` is the JSON object returned by the ObservableHQ document
        API. It must contain a ``nodes`` sequence. Optional ``files`` records
        become URL-backed attachments. Explicit ``files`` override uploaded
        files with the same name.
        """

        model = notebook_model_from_observablehq_document(
            document,
            title=title,
            files=files,
        )
        return cls._from_model(
            model,
            variables=variables,
            show_pinned_source=show_pinned_source,
        )

    @classmethod
    def from_observablehq_page_data(
        cls,
        page_data: ObservablePageData | Mapping[str, Any],
        *,
        title: str | None = None,
        variables: Mapping[str, Any] | None = None,
        files: Mapping[str, FileInput] | None = None,
        show_pinned_source: bool = False,
    ) -> "Notebook":
        """Create a notebook from Observable page data with ``initialNotebook``.

        ``page_data`` must contain ``pageProps.initialNotebook`` or a top-level
        ``initialNotebook`` mapping. The nested notebook mapping uses the same
        ``title``, ``nodes``, and ``files`` shape accepted by
        ``from_observablehq_document``.
        """

        model = notebook_model_from_observablehq_page_data(
            page_data,
            title=title,
            files=files,
        )
        return cls._from_model(
            model,
            variables=variables,
            show_pinned_source=show_pinned_source,
        )

    @classmethod
    def from_observablehq_nodes(
        cls,
        nodes: Sequence[ObservableNodeInput],
        *,
        observable_files: ObservableFilesInput = None,
        title: str = "Untitled",
        variables: Mapping[str, Any] | None = None,
        files: Mapping[str, FileInput] | None = None,
        show_pinned_source: bool = False,
    ) -> "Notebook":
        """Create a notebook from ObservableHQ node and file records.

        ``nodes`` accepts the node records used by the ObservableHQ document API.
        JavaScript nodes use OJS semantics after import. ``observable_files``
        accepts uploaded file records with ``name`` and ``download_url``.
        Explicit ``files`` override uploaded files with the same name.
        """

        model = notebook_model_from_observablehq_nodes(
            nodes,
            files=observable_files,
            title=title,
            local_files=files,
        )
        return cls._from_model(
            model,
            variables=variables,
            show_pinned_source=show_pinned_source,
        )

    def to_notebook_html(self) -> str:
        """Return Notebook Kit HTML for saving or inspecting the notebook."""

        if self._source:
            return self._source
        return serialize(self._spec)


class NotebookView(_ObservableWidget):
    """Display model for a full notebook or an explicit cell selection."""

    role = traitlets.Unicode("view").tag(sync=True)
    _notebook = traitlets.Instance(Notebook).tag(
        sync=True,
        to_json=_WIDGET_TO_JSON,
        from_json=_WIDGET_FROM_JSON,
    )
    _cell_indexes = traitlets.Any(default_value=None, allow_none=True).tag(sync=True)
    _readback = traitlets.Dict(
        default_value={
            "revision": 0,
            "rendered": False,
            "graph": {},
            "cells": {},
        }
    ).tag(sync=True)

    def __init__(
        self,
        notebook: Notebook,
        cell_indexes: Sequence[int] | None = None,
    ) -> None:
        if notebook._notebook_closed:
            raise RuntimeError("Cannot create a view from a closed Notebook")
        self._view_closed = False
        if cell_indexes is None:
            indexes = None
        else:
            _require_sequence_container(
                cell_indexes,
                message="cell_indexes must be a sequence of notebook cell indexes",
            )
            indexes = list(cell_indexes)
        super().__init__(_notebook=notebook, _cell_indexes=indexes)
        notebook._views.add(self)

    @traitlets.validate("_cell_indexes")
    def _validate_cell_indexes(self, proposal: Any) -> list[int] | None:
        value = proposal["value"]
        if value is None:
            return None
        if (
            not isinstance(value, list)
            or len(value) == 0
            or any(
                not isinstance(index, int)
                or isinstance(index, bool)
                or index < 0
                or index >= len(self._notebook._cell_keys)
                for index in value
            )
        ):
            raise traitlets.TraitError(
                "_cell_indexes must be null or a non-empty list of notebook cell indexes"
            )
        if len(value) != len(set(value)):
            raise traitlets.TraitError("_cell_indexes must contain unique indexes")
        return sorted(value)

    @traitlets.validate("_readback")
    def _validate_readback(self, proposal: Any) -> dict[str, Any]:
        value = proposal["value"]
        revision = value.get("revision")
        if (
            not isinstance(revision, int)
            or isinstance(revision, bool)
            or revision < 0
            or revision > (1 << 53) - 1
            or not isinstance(value.get("rendered"), bool)
            or not isinstance(value.get("graph"), Mapping)
            or not isinstance(value.get("cells"), Mapping)
        ):
            raise traitlets.TraitError(
                "_readback must be a revisioned browser snapshot"
            )
        current = self._trait_values.get("_readback")
        current_revision = (
            current.get("revision") if isinstance(current, Mapping) else -1
        )
        # Marimo transports model saves as independent requests, so a delayed
        # snapshot must not replace one that Python has already accepted.
        if isinstance(current_revision, int) and revision <= current_revision:
            return cast(dict[str, Any], current)
        return cast(dict[str, Any], value)

    @property
    def notebook(self) -> Notebook:
        """Session rendered by this view."""

        return self._notebook

    @property
    def cell_indexes(self) -> tuple[int, ...] | None:
        """Selected indexes in notebook order, or ``None`` for the full notebook."""

        return None if self._cell_indexes is None else tuple(self._cell_indexes)

    @property
    def variables(self) -> dict[str, Any]:
        """Current Python-owned Observable variables."""

        return self._notebook.variables

    def update_variables(
        self,
        values: Mapping[str, Any] | Iterable[tuple[str, Any]] | None = None,
        /,
        **kwargs: Any,
    ) -> None:
        """Merge Python-owned variable updates into this view's session."""

        self._require_open()
        self._notebook.update_variables(values, **kwargs)

    def replace_variables(
        self,
        values: Mapping[str, Any] | Iterable[tuple[str, Any]] | None = None,
        /,
        **kwargs: Any,
    ) -> None:
        """Replace the Python-owned variables in this view's session."""

        self._require_open()
        self._notebook.replace_variables(values, **kwargs)

    def reset_variables(self, *names: str) -> None:
        """Release Python ownership for names in this view's session."""

        self._require_open()
        self._notebook.reset_variables(*names)

    def _require_open(self) -> None:
        if self._view_closed:
            raise RuntimeError("Cannot mutate a closed NotebookView")
        self._notebook._require_open()

    @property
    def has_rendered(self) -> bool:
        """Whether this view has synchronized a complete browser render."""

        return self._readback.get("rendered") is True

    @property
    def has_graph_snapshot(self) -> bool:
        """Whether this view has synchronized notebook graph metadata."""

        return graph_from_raw(self._readback.get("graph")) is not None

    def _require_rendered(self) -> None:
        if not self.has_rendered:
            raise NotRenderedError(
                "NotebookView readback is available after the view renders in a browser"
            )

    @property
    def graph(self) -> NotebookGraph:
        """Symbolic cell graph synchronized from this browser view."""

        graph = graph_from_raw(self._readback.get("graph"))
        if graph is None:
            raise NotRenderedError(
                "NotebookView graph metadata is available after the view renders in a browser"
            )
        return graph

    @property
    def runtime_values(self) -> dict[str, Any]:
        """Latest unambiguous browser values synchronized from this view."""

        self._require_rendered()
        owners: dict[str, tuple[int, Any]] = {}
        cells = self._readback.get("cells")
        for record in cells.values() if isinstance(cells, Mapping) else ():
            if not isinstance(record, Mapping):
                continue
            values = record.get("values")
            if not isinstance(values, Mapping):
                continue
            for name, value in values.items():
                if not isinstance(name, str):
                    continue
                count, _previous = owners.get(name, (0, None))
                owners[name] = (count + 1, value)
        return {
            name: deserialize_value(value)
            for name, (count, value) in owners.items()
            if count == 1
        }

    def cell_values(self) -> tuple[CellValues, ...]:
        """Return browser-synchronized values for the cells in this view."""

        self._require_rendered()
        indexes = (
            range(len(self._notebook._cell_keys))
            if self._cell_indexes is None
            else self._cell_indexes
        )
        return tuple(
            CellValues(
                index=index,
                key=self._notebook._cell_keys[index] or None,
                values=self._cell_runtime_values(index),
            )
            for index in indexes
        )

    def value(self, name: str) -> Any:
        """Return the synchronized value for ``name``."""

        return self.runtime_values[name]

    def _cell_runtime_values(self, index: int) -> dict[str, Any]:
        cells = self._readback.get("cells")
        record = cells.get(str(index)) if isinstance(cells, Mapping) else None
        values = record.get("values") if isinstance(record, Mapping) else None
        if not isinstance(values, Mapping):
            return {}
        return {
            name: deserialize_value(value)
            for name, value in values.items()
            if isinstance(name, str)
        }

    def close(self) -> None:
        """Close this display model."""

        if getattr(self, "_view_closed", False):
            return
        self._view_closed = True
        notebook = getattr(self, "_trait_values", {}).get("_notebook")
        if notebook is not None:
            notebook._views.discard(self)
        super().close()
