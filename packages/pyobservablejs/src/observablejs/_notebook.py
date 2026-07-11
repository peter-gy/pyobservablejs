"""Python widget models for Observable notebooks and cells."""

from __future__ import annotations

import pathlib
import dataclasses
from collections.abc import Iterable, Mapping, Sequence
from typing import Any, cast

import anywidget
import traitlets

from ._cells import NotebookCellInput
from ._files import FileAttachment, FileInput
from ._graph import CellInfo, NotebookGraph, graph_from_raw
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
from ._variables import copy_variables, deserialize_value, serialize_variables
from ._variables import variable_updates_from_args
from ._anywidget_bundle import Bundle, BundledWidget


_WIDGET_TRAIT = anywidget.WidgetTrait()
_WIDGET_TO_JSON = _WIDGET_TRAIT.metadata["to_json"]
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


class NotRenderedError(RuntimeError):
    """Raised when browser-synchronized notebook state is read before render."""


@dataclasses.dataclass(frozen=True)
class CellValues:
    """Browser-synchronized values for one rendered cell."""

    index: int
    key: str | None
    values: dict[str, Any]


def _widgets_to_json(value: object, widget: object) -> object:
    if not isinstance(value, list):
        return value
    return [_WIDGET_TO_JSON(item, widget) for item in value]


def _widgets_from_json(value: object, _widget: object) -> object:
    return value


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


class _WidgetReferenceTrait(anywidget.WidgetTrait):
    """WidgetTrait variant that also accepts anywidget wire references."""

    def validate(self, obj: object, value: object) -> object:
        if isinstance(value, str) and value.startswith("anywidget:"):
            return value
        return super().validate(obj, value)


class _ObservableWidget(BundledWidget):
    """Shared anywidget base for the bundled frontend assets."""

    bundle = _OBSERVABLE_WIDGET_BUNDLE


class NotebookCell(_ObservableWidget):
    """Child anywidget model for one Observable cell.

    The parent ``Notebook`` owns rendering and Observable runtime state.
    ``NotebookCell`` exposes browser-synchronized values and graph metadata for
    its matching cell.
    """

    role = traitlets.Unicode("cell").tag(sync=True)
    key = traitlets.Unicode("").tag(sync=True)
    name = traitlets.Unicode("").tag(sync=True)
    _notebook_widget = _WidgetReferenceTrait().tag(sync=True)
    _notebook_index = traitlets.Int(-1).tag(sync=True)
    _has_rendered = traitlets.Bool(False).tag(sync=True)
    _value_names = traitlets.List(traitlets.Unicode(), default_value=[]).tag(sync=True)
    _values = traitlets.Dict(default_value={}).tag(sync=True)

    def __init__(self, **kwargs: Any) -> None:
        self._notebook: Notebook | None = None
        super().__init__(**kwargs)

    def _bind_notebook(self, notebook: Notebook, index: int) -> None:
        self._notebook = notebook
        self.set_trait("_notebook_widget", notebook)
        self.set_trait("_notebook_index", index)

    def _require_rendered(self) -> None:
        if not self.has_rendered:
            raise NotRenderedError(
                "NotebookCell readback is available after the cell renders in a browser"
            )

    @property
    def has_rendered(self) -> bool:
        """Whether this cell has synced a rendered browser output."""

        return self._has_rendered

    @property
    def info(self) -> CellInfo:
        """Notebook Kit metadata for this cell after browser render."""

        if self._notebook is None or self._notebook_index < 0:
            raise NotRenderedError("NotebookCell is not bound to a rendered Notebook")
        self._notebook._require_graph_snapshot()
        graph = self._notebook.graph
        info = graph.cell(self._notebook_index)
        if info is None:
            raise KeyError(f"Unknown rendered cell index: {self._notebook_index}")
        return info

    @property
    def defines(self) -> tuple[str, ...]:
        return self.info.defines

    @property
    def references(self) -> tuple[str, ...]:
        return self.info.references

    @property
    def outputs(self) -> tuple[str, ...]:
        return self.info.outputs

    @property
    def runtime_outputs(self) -> tuple[str, ...]:
        return self.info.runtime_outputs

    @property
    def output(self) -> str | None:
        return self.info.output

    @property
    def values(self) -> dict[str, Any]:
        """Latest browser-synchronized values exposed by this cell."""

        self._require_rendered()
        return {name: deserialize_value(value) for name, value in self._values.items()}

    def value(self, name: str) -> Any:
        """Return this cell's synchronized value for ``name``."""

        return self.values[name]

    def only_value(self) -> Any:
        """Return the cell's only synchronized value.

        Raises ``KeyError`` when the cell has no values or more than one value.
        """

        values = self.values
        if len(values) == 1:
            return next(iter(values.values()))
        if not values:
            raise KeyError("Cell exposes no synchronized values")
        raise KeyError("Cell exposes multiple values. Use cell.value(name)")


class Notebook(_ObservableWidget):
    """anywidget model for an Observable Notebook Kit notebook.

    Python owns cell specs, attachments, and Python-backed OJS variables. The
    browser renderer creates the Observable runtime, renders outputs, and syncs
    values plus graph metadata back to this model.
    """

    role = traitlets.Unicode("notebook").tag(sync=True)
    _source = traitlets.Unicode("").tag(sync=True)
    _spec = traitlets.Dict().tag(sync=True)
    theme = traitlets.Any(default_value="air").tag(sync=True)
    _attachments = traitlets.Dict().tag(sync=True)
    _base_url = traitlets.Unicode("").tag(sync=True)
    _variables = traitlets.Dict(default_value={}).tag(sync=True)
    _variable_update = traitlets.Dict(default_value={}).tag(sync=True)
    _has_rendered = traitlets.Bool(False).tag(sync=True)
    _graph = traitlets.Dict(default_value={}).tag(sync=True)
    _values = traitlets.Dict(default_value={}).tag(sync=True)
    _options = traitlets.Dict().tag(sync=True)
    _cell_keys = traitlets.List(traitlets.Unicode(), default_value=[]).tag(sync=True)
    _cell_widgets = traitlets.List(
        anywidget.WidgetTrait(),
        default_value=[],
    ).tag(sync=True, to_json=_widgets_to_json, from_json=_widgets_from_json)

    @traitlets.validate("_cell_widgets")
    def _validate_cell_widgets(self, proposal: Any) -> list[NotebookCell]:
        widgets = proposal["value"]
        if not all(isinstance(item, NotebookCell) for item in widgets):
            raise traitlets.TraitError(
                "_cell_widgets must contain NotebookCell widgets"
            )
        return cast(list[NotebookCell], widgets)

    @traitlets.validate("theme")
    def _validate_theme(self, proposal: Any) -> Theme:
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
            cell_widgets=_cell_widgets_for_model(model),
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
        cell_widgets: Sequence[NotebookCell],
    ) -> None:
        self._variable_values = copy_variables(variables)
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
                _variables=serialize_variables(self._variable_values),
                _options=options,
                _cell_keys=list(cell_keys),
                _cell_widgets=list(cell_widgets),
            )
        finally:
            self._initializing_notebook = False
        for index, cell_widget in enumerate(self._cell_widgets):
            if isinstance(cell_widget, NotebookCell):
                cell_widget._bind_notebook(self, index)

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

        if not names:
            return
        values = dict(self._variable_values)
        changed = False
        for name in names:
            if name in values:
                del values[name]
                changed = True
        if changed:
            self._replace_variables(values, update_kind="replace")

    def _patch_variables(self, updates: Mapping[str, Any]) -> None:
        self._validate_runtime_compatibility_variables(updates)
        serialized_updates = serialize_variables(updates)
        self._variable_values = copy_variables({**self._variable_values, **updates})
        self._variable_update_seq += 1
        self.set_trait(
            "_variable_update",
            {
                "seq": self._variable_update_seq,
                "kind": "set",
                "values": serialized_updates,
            },
        )
        self.set_trait("_variables", serialize_variables(self._variable_values))

    def _replace_variables(
        self,
        value: Mapping[str, Any],
        *,
        update_kind: str = "replace",
    ) -> None:
        self._validate_runtime_compatibility_variables(value)
        self._variable_values = copy_variables(value)
        self._variable_update_seq += 1
        self.set_trait(
            "_variable_update",
            {
                "seq": self._variable_update_seq,
                "kind": update_kind,
                "values": serialize_variables(self._variable_values),
            },
        )
        self.set_trait("_variables", serialize_variables(self._variable_values))

    def _validate_runtime_compatibility_variables(
        self, values: Mapping[str, Any]
    ) -> None:
        validate_runtime_compatibility_variables(
            values, self._options.get("runtime_compatibility")
        )

    @property
    def has_rendered(self) -> bool:
        """Whether the browser has synced a full notebook render."""

        return self._has_rendered

    @property
    def has_graph_snapshot(self) -> bool:
        """Whether the browser has synced notebook graph metadata."""

        return (
            isinstance(self._graph, Mapping)
            and isinstance(self._graph.get("cells"), list)
            and isinstance(self._graph.get("edges"), list)
        )

    def _require_rendered(self) -> None:
        if not self.has_rendered:
            raise NotRenderedError(
                "Notebook readback is available after the widget renders in a browser"
            )

    def _require_graph_snapshot(self) -> None:
        if not self.has_graph_snapshot:
            raise NotRenderedError(
                "Notebook graph metadata is available after a notebook or cell renders in a browser"
            )

    @property
    def graph(self) -> NotebookGraph:
        """Symbolic cell graph synced from the browser runtime."""

        self._require_graph_snapshot()
        graph = graph_from_raw(self._graph)
        if graph is None:
            raise NotRenderedError("Browser graph snapshot is unavailable")
        return graph

    @property
    def cells(self) -> tuple[NotebookCell, ...]:
        """Child cell widgets in notebook order."""

        return tuple(self._cell_widgets)

    def cell_at(self, index: int) -> NotebookCell:
        """Return the cell widget at zero-based notebook order."""

        return self.cells[index]

    def cell_by_key(self, key: str) -> NotebookCell:
        """Return the unique cell widget with Python handle ``key``."""

        matches = [item for item in self.cells if item.key == key]
        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            raise KeyError(f"Ambiguous Observable cell key: {key!r}")
        raise KeyError(f"Unknown Observable cell key: {key!r}")

    def cell_for_variable(self, name: str) -> NotebookCell:
        """Return the unique cell that defines an Observable variable."""

        cells = self.cells
        matches = [cell.index for cell in self.graph.cells if name in cell.defines]
        if len(matches) == 1:
            index = matches[0]
            if 0 <= index < len(cells):
                return cells[index]
        if len(matches) > 1:
            raise KeyError(f"Ambiguous Observable variable: {name!r}")
        raise KeyError(f"Unknown Observable variable: {name!r}")

    @property
    def runtime_values(self) -> dict[str, Any]:
        """Latest notebook-level browser values synchronized from the runtime."""

        self._require_rendered()
        return {name: deserialize_value(value) for name, value in self._values.items()}

    def cell_values(self) -> tuple[CellValues, ...]:
        """Return browser-synchronized values in notebook order."""

        self._require_rendered()
        return tuple(
            CellValues(index=index, key=cell.key or None, values=cell.values)
            for index, cell in enumerate(self.cells)
        )

    def value(self, name: str) -> Any:
        """Return the notebook-level browser value synchronized for ``name``."""

        return self.runtime_values[name]

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


def _cell_widgets_for_model(model: NotebookModel) -> list[NotebookCell]:
    return [
        NotebookCell(key=key, name=name)
        for key, name in zip(model.cell_keys, model.cell_names, strict=True)
    ]
