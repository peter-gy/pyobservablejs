"""Python widget models for Observable notebooks and cells."""

from __future__ import annotations

import dataclasses
import pathlib
import weakref
from collections.abc import Iterable, Mapping, Sequence
from typing import Any, cast

import anywidget
import traitlets

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
    deserialize_value,
    prepare_variables,
    same_wire_value,
    validate_variable_name,
)
from ._variables import variable_updates_from_args
from ._anywidget_bundle import Bundle, BundledWidget


_WIDGET_TRAIT = anywidget.WidgetTrait()
_WIDGET_TO_JSON = _WIDGET_TRAIT.metadata["to_json"]
_WIDGET_FROM_JSON = _WIDGET_TRAIT.metadata["from_json"]
_OBSERVABLE_WIDGET_STATIC_DIR = pathlib.Path(__file__).parent / "static"
_OBSERVABLE_WIDGET_DEV_SERVER_ENV = "OBSERVABLEJS_VITE_DEV_SERVER"
_OBSERVABLE_WIDGET_BUNDLE = Bundle(
    static_dir=_OBSERVABLE_WIDGET_STATIC_DIR,
    dev_server_env=_OBSERVABLE_WIDGET_DEV_SERVER_ENV,
)
_RUNTIME_COMPATIBILITY_VARIABLE_NAMES = {
    "generators": "Generators",
    "html": "html",
    "mutable": "Mutable",
    "require": "require",
}
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


def validate_runtime_compatibility_variables(
    values: Mapping[str, Any],
    runtime_compatibility: object,
) -> None:
    if not isinstance(runtime_compatibility, Mapping):
        return
    collisions = sorted(
        name
        for option, name in _RUNTIME_COMPATIBILITY_VARIABLE_NAMES.items()
        if runtime_compatibility.get(option) is True and name in values
    )
    if collisions:
        joined = ", ".join(repr(name) for name in collisions)
        raise ValueError(f"Reserved Observable runtime name: {joined}")


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
        self._initialize(
            source=model.source,
            spec=model.spec,
            theme=model.theme,
            attachments=model.attachments,
            variables=variables,
            show_pinned_source=show_pinned_source,
            runtime_compatibility=model.runtime_compatibility,
            cell_keys=model.cell_keys,
            cell_names=model.cell_names,
        )

    def _initialize(
        self,
        *,
        source: str,
        spec: Mapping[str, Any],
        theme: Theme,
        attachments: Mapping[str, FileAttachment],
        variables: Mapping[str, Any] | None,
        show_pinned_source: bool,
        runtime_compatibility: Mapping[str, bool],
        cell_keys: Sequence[str],
        cell_names: Sequence[str],
    ) -> None:
        self._variable_values, variable_wire = prepare_variables(variables)
        self._cell_names = tuple(cell_names)
        self._cell_cache: dict[int, NotebookCell] = {}
        self._views: weakref.WeakSet[NotebookView] = weakref.WeakSet()
        self._notebook_closed = False
        spec_dict = dict(spec)
        if not source:
            spec_dict["theme"] = theme
        options: dict[str, Any] = {"show_source": show_pinned_source}
        if runtime_compatibility:
            options["runtime_compatibility"] = dict(runtime_compatibility)
        validate_runtime_compatibility_variables(
            self._variable_values, options.get("runtime_compatibility")
        )
        self._variable_update_seq = 0
        self._initializing_notebook = True
        try:
            super().__init__(
                _source=source,
                _spec=spec_dict,
                theme=theme,
                _attachments=dict(attachments),
                _variables=variable_wire,
                _options=options,
                _cell_keys=list(cell_keys),
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
        self._replace_variables(
            variable_updates_from_args("replace_variables", values, kwargs),
            update_kind="replace",
        )

    def reset_variables(self, *names: str) -> None:
        """Release Python ownership for names that are currently overridden.

        Empty calls and missing names are no-ops. Removing at least one name
        sends a replacement update and restores original notebook definitions in
        the browser runtime.
        """

        self._require_open()
        if not names:
            return
        validated_names = tuple(validate_variable_name(name) for name in names)
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
                update_kind="replace",
            )

    def _require_open(self) -> None:
        if self._notebook_closed:
            raise RuntimeError("Cannot mutate a closed Notebook")

    def _patch_variables(self, updates: Mapping[str, Any]) -> None:
        self._validate_runtime_compatibility_variables(updates)
        prepared_updates, serialized_updates = prepare_variables(updates)
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

    def _replace_variables(
        self,
        value: Mapping[str, Any],
        *,
        update_kind: str = "replace",
    ) -> None:
        self._validate_runtime_compatibility_variables(value)
        prepared, serialized = prepare_variables(value)
        self._apply_variable_replacement(
            prepared,
            serialized,
            update_kind=update_kind,
        )

    def _apply_variable_replacement(
        self,
        values: Mapping[str, Any],
        serialized: Mapping[str, Any],
        *,
        update_kind: str,
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
                "kind": update_kind,
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

    def _validate_runtime_compatibility_variables(
        self, values: Mapping[str, Any]
    ) -> None:
        validate_runtime_compatibility_variables(
            values, self._options.get("runtime_compatibility")
        )

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
        view = NotebookView(
            notebook=self,
            cell_indexes=indexes,
        )
        return view

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
        views = getattr(self, "_views", None)
        live_views = tuple(views) if views is not None else ()
        if views is not None:
            views.clear()
        for view in live_views:
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

        Examples:
            Create a notebook from literal Notebook Kit HTML:

            .. code-block:: python

                import observablejs as obs

                source = '''
                <!doctype html>
                <notebook theme="air">
                  <script
                    id="1"
                    type="application/vnd.observable.javascript"
                    name="answer"
                  >answer = 42</script>
                </notebook>
                '''

                notebook = obs.Notebook.from_html(source)
                assert notebook.cells[0].key == "answer"

            Resolve local ``FileAttachment`` calls and relative imports from a
            known directory:

            .. code-block:: python

                import pathlib
                import tempfile

                import observablejs as obs

                source = '''
                <!doctype html>
                <notebook>
                  <script id="1" type="module" name="scale">
                    import {scale} from "./scale.js";
                    export default scale;
                  </script>
                  <script
                    id="2"
                    type="application/vnd.observable.javascript"
                    name="rows"
                  >rows = FileAttachment("rows.csv").csv()</script>
                </notebook>
                '''

                with tempfile.TemporaryDirectory() as directory:
                    base_path = pathlib.Path(directory)
                    (base_path / "scale.js").write_text(
                        "export const scale = 2;",
                        encoding="utf-8",
                    )
                    (base_path / "rows.csv").write_text("x\\n1\\n", encoding="utf-8")

                    notebook = obs.Notebook.from_html(
                        source,
                        base_path=base_path,
                        embed_file_attachments=True,
                        rewrite_imports=True,
                    )
                    assert "rows.csv" in notebook.attachments
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
    def from_html_file(
        cls,
        path: str | pathlib.Path,
        *,
        files: Mapping[str, FileInput] | None = None,
        embed_file_attachments: bool = False,
        rewrite_imports: bool = False,
        variables: Mapping[str, Any] | None = None,
        show_pinned_source: bool = False,
    ) -> "Notebook":
        """Create a source-backed notebook from a Notebook Kit HTML file.

        The HTML file's parent directory is used as ``base_path`` when
        ``embed_file_attachments`` or ``rewrite_imports`` is enabled. Explicit
        ``files`` override discovered files with the same name.

        Examples:
            Load a Notebook Kit file from disk:

            .. code-block:: python

                import pathlib
                import tempfile

                import observablejs as obs

                with tempfile.TemporaryDirectory() as directory:
                    path = pathlib.Path(directory) / "report.html"
                    path.write_text(
                        '''
                        <!doctype html>
                        <notebook>
                          <script
                            id="1"
                            type="application/vnd.observable.javascript"
                            name="answer"
                          >answer = 42</script>
                        </notebook>
                        ''',
                        encoding="utf-8",
                    )

                    notebook = obs.Notebook.from_html_file(path)
                    assert notebook.cells[0].key == "answer"
        """

        source_path = pathlib.Path(path)
        return cls.from_html(
            source_path.read_text(encoding="utf-8"),
            files=files,
            base_path=source_path.parent,
            embed_file_attachments=embed_file_attachments,
            rewrite_imports=rewrite_imports,
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

        Examples:
            Fetch by slug:

            .. code-block:: python

                import observablejs as obs

                notebook = obs.Notebook.from_observablehq(
                    "@d3/bar-chart",
                    timeout=10,
                )

            Accepted specifier shapes:

            .. code-block:: python

                specifiers = [
                    "@d3/bar-chart",
                    "https://observablehq.com/@d3/bar-chart",
                    "1234567890abcdef",
                    "https://observablehq.com/d/1234567890abcdef",
                    "https://api.observablehq.com/document/@d3/bar-chart",
                ]
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

        Examples:
            Build from an already-fetched document mapping:

            .. code-block:: python

                import observablejs as obs

                document = {
                    "title": "Fetched notebook",
                    "nodes": [
                        {
                            "id": 1,
                            "mode": "js",
                            "name": "answer",
                            "value": "answer = 42",
                            "pinned": True,
                        }
                    ],
                    "files": [
                        {
                            "name": "rows.csv",
                            "download_url": "https://example.test/rows.csv",
                            "mime_type": "text/csv",
                        }
                    ],
                }

                notebook = obs.Notebook.from_observablehq_document(document)
                assert notebook.cells[0].key == "answer"
                assert notebook.attachments["rows.csv"]["mimeType"] == "text/csv"
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

        Examples:
            Build from page data captured from an Observable page:

            .. code-block:: python

                import observablejs as obs

                page_data = {
                    "pageProps": {
                        "initialNotebook": {
                            "title": "Page notebook",
                            "nodes": [
                                {
                                    "id": 1,
                                    "mode": "js",
                                    "name": "answer",
                                    "value": "answer = 42",
                                }
                            ],
                        }
                    }
                }

                notebook = obs.Notebook.from_observablehq_page_data(page_data)
                assert notebook.cells[0].key == "answer"
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

        Examples:
            Build directly from raw node and file records:

            .. code-block:: python

                import observablejs as obs

                nodes = [
                    {
                        "id": 1,
                        "mode": "js",
                        "name": "rows",
                        "value": "rows = [{x: 1}, {x: 2}]",
                    },
                    {
                        "id": 2,
                        "mode": "js",
                        "name": "answer",
                        "value": "answer = rows.length",
                        "pinned": True,
                    },
                ]
                observable_files = [
                    {
                        "name": "rows.csv",
                        "download_url": "https://example.test/rows.csv",
                        "mime_type": "text/csv",
                    }
                ]

                notebook = obs.Notebook.from_observablehq_nodes(
                    nodes,
                    observable_files=observable_files,
                    title="Imported notebook",
                    variables={"scale": 2},
                )
                assert notebook.cells[1].key == "answer"
                assert notebook.attachments["rows.csv"]["url"].startswith("https://")
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
    _has_rendered = traitlets.Bool(False).tag(sync=True)
    _graph = traitlets.Dict(default_value={}).tag(sync=True)
    _cell_values = traitlets.Dict(default_value={}).tag(sync=True)

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

        return self._has_rendered

    @property
    def has_graph_snapshot(self) -> bool:
        """Whether this view has synchronized notebook graph metadata."""

        return (
            isinstance(self._graph, Mapping)
            and isinstance(self._graph.get("cells"), list)
            and isinstance(self._graph.get("edges"), list)
        )

    def _require_rendered(self) -> None:
        if not self.has_rendered:
            raise NotRenderedError(
                "NotebookView readback is available after the view renders in a browser"
            )

    def _require_graph_snapshot(self) -> None:
        if not self.has_graph_snapshot:
            raise NotRenderedError(
                "NotebookView graph metadata is available after the view renders in a browser"
            )

    @property
    def graph(self) -> NotebookGraph:
        """Symbolic cell graph synchronized from this browser view."""

        self._require_graph_snapshot()
        graph = graph_from_raw(self._graph)
        if graph is None:
            raise NotRenderedError("Browser graph snapshot is unavailable")
        return graph

    @property
    def runtime_values(self) -> dict[str, Any]:
        """Latest unambiguous browser values synchronized from this view."""

        self._require_rendered()
        owners: dict[str, tuple[int, Any]] = {}
        for record in self._cell_values.values():
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

    def _cell_record(self, index: int) -> Mapping[str, Any]:
        record = self._cell_values.get(str(index))
        return record if isinstance(record, Mapping) else {}

    def _cell_runtime_values(self, index: int) -> dict[str, Any]:
        values = self._cell_record(index).get("values")
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
