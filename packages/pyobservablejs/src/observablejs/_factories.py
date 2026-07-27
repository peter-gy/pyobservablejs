"""Standalone factories for renderable notebook views."""

from __future__ import annotations

import pathlib
from collections.abc import Mapping
from typing import Unpack

from ._cells import Cell
from ._notebook import Notebook, NotebookView
from ._view_options import (
    ResolvedNotebookViewOptions,
    resolve_notebook_view_options,
)
from .types import (
    CellMode,
    FileInput,
    NotebookViewOptions,
    ObservableDocument,
    Theme,
)


def _standalone_view(
    notebook: Notebook,
    view_options: ResolvedNotebookViewOptions,
) -> NotebookView:
    try:
        view = notebook._create_view((), view_options)
        view._owns_notebook = True
        return view
    except Exception:
        notebook.close()
        raise


def view_from_code(
    code: str,
    *,
    mode: CellMode = "ojs",
    title: str = "Untitled",
    theme: Theme = "air",
    files: Mapping[str, FileInput] | None = None,
    base_path: str | pathlib.Path | None = None,
    variables: Mapping[str, object] | None = None,
    **view_options: Unpack[NotebookViewOptions],
) -> NotebookView:
    """Create a renderable view from one Notebook Kit source cell.

    The code uses Observable JavaScript by default. Set mode to select another
    cell language. Closing the returned view also closes its notebook session.
    Set ``capture_state=False`` to skip browser evaluation readback.

    Examples:
        Create a slider view from one Observable JavaScript cell:

        >>> import observablejs as obs
        >>> view = obs.view_from_code(
        ...     "viewof quantity = Inputs.range([0, 100], {step: 1})"
        ... )
        >>> view.close()

    Runtime and imports:
        Notebook Kit makes ``Inputs``, ``Plot``, ``d3``, ``DuckDBClient``,
        ``htl``, ``html``, ``svg``, ``md``, ``tex``, ``dot``, ``_``, ``aq``,
        ``Arrow``, ``duckdb``, ``echarts``, ``L``, ``mapboxgl``, ``mermaid``,
        ``React``, ``ReactDOM``, ``topojson``, and ``vl`` available as cell
        globals. It also provides ``DatabaseClient``, ``FileAttachment``,
        ``Generators``, ``Mutable``, ``SQLite``, ``SQLiteDatabaseClient``,
        ``now``, ``width``, ``dark``, and the Notebook Kit sample datasets.
        Use these names directly in cells. Most library globals and datasets
        load from jsDelivr when first used.

        JavaScript and TypeScript cells resolve ``npm:`` imports through
        jsDelivr, ``jsr:`` imports through esm.sh, and ``observable:`` imports
        through the Observable API. Full browser URLs pass through unchanged.
        Relative module paths resolve against the host page URL. Observable
        JavaScript imports such as
        ``import {name} from "@observablehq/hello-world"`` load Observable
        notebooks. Literal dynamic imports such as
        ``import("d3-format@3")`` load npm packages from jsDelivr.
    """

    resolved_view_options = resolve_notebook_view_options(view_options)
    notebook = Notebook(
        Cell(code, mode=mode),
        title=title,
        theme=theme,
        files=files,
        base_path=base_path,
        variables=variables,
    )
    return _standalone_view(notebook, resolved_view_options)


def view_from_html(
    source: str,
    *,
    files: Mapping[str, FileInput] | None = None,
    base_path: str | pathlib.Path | None = None,
    embed_file_attachments: bool = False,
    rewrite_imports: bool = False,
    variables: Mapping[str, object] | None = None,
    show_pinned_source: bool = False,
    **view_options: Unpack[NotebookViewOptions],
) -> NotebookView:
    """Create a renderable view from Notebook Kit HTML text.

    The HTML can mix Notebook Kit cell modes. See the official Notebook Kit
    documentation at https://observablehq.com/notebook-kit/kit for the HTML
    format and cell modes.

    Closing the returned view also closes its notebook session. Set
    ``capture_state=False`` to skip browser evaluation readback.

    Examples:
        Create a view with Markdown, JavaScript, TypeScript, Observable
        JavaScript, HTML, TeX, DOT, and SQL cells:

        >>> import observablejs as obs
        >>> source = r'''
        ... <!doctype html>
        ... <notebook theme="air">
        ...   <title>Browser cell modes</title>
        ...   <script id="1" type="text/markdown">
        ...     # Browser cell modes
        ...   </script>
        ...   <script id="2" type="module">
        ...     import {format} from "npm:d3-format@3";
        ...     const values = [{value: 1}, {value: 2}, {value: 3}];
        ...     const compact = format(".2s");
        ...     const db = DuckDBClient.of({values});
        ...   </script>
        ...   <script id="3" type="text/x-typescript">
        ...     const total: number = values.reduce(
        ...       (sum, row) => sum + row.value,
        ...       0
        ...     );
        ...   </script>
        ...   <script id="4" type="application/vnd.observable.javascript">
        ...     viewof limit = Inputs.range(
        ...       [1, 10],
        ...       {value: total, step: 1, label: "Limit"}
        ...     )
        ...   </script>
        ...   <script id="5" type="text/html">
        ...     <strong>${compact(total)} total, limit ${limit}</strong>
        ...   </script>
        ...   <script id="6" type="application/x-tex">
        ...     \\sum_{i=1}^{3} i = 6
        ...   </script>
        ...   <script id="7" type="text/vnd.graphviz">
        ...     digraph { values -> total -> limit }
        ...   </script>
        ...   <script id="8" type="application/sql" database="var:db" output="rows">
        ...     SELECT sum(value) AS total FROM values
        ...   </script>
        ... </notebook>
        ... '''
        >>> view = obs.view_from_html(source)
        >>> view.close()

    Runtime and imports:
        Notebook Kit makes ``Inputs``, ``Plot``, ``d3``, ``DuckDBClient``,
        ``htl``, ``html``, ``svg``, ``md``, ``tex``, ``dot``, ``_``, ``aq``,
        ``Arrow``, ``duckdb``, ``echarts``, ``L``, ``mapboxgl``, ``mermaid``,
        ``React``, ``ReactDOM``, ``topojson``, and ``vl`` available as cell
        globals. It also provides ``DatabaseClient``, ``FileAttachment``,
        ``Generators``, ``Mutable``, ``SQLite``, ``SQLiteDatabaseClient``,
        ``now``, ``width``, ``dark``, and the Notebook Kit sample datasets.
        Use these names directly in cells. Most library globals and datasets
        load from jsDelivr when first used.

        JavaScript and TypeScript cells resolve ``npm:`` imports through
        jsDelivr, ``jsr:`` imports through esm.sh, and ``observable:`` imports
        through the Observable API. Full browser URLs pass through unchanged.
        Relative module paths resolve against the host page URL. Pass
        ``base_path`` and ``rewrite_imports=True`` to embed quoted relative
        imports, export-from declarations, and literal dynamic imports as data
        URLs. Local imports are followed recursively. Computed import
        specifiers stay unchanged.
    """

    resolved_view_options = resolve_notebook_view_options(view_options)
    notebook = Notebook.from_html(
        source,
        files=files,
        base_path=base_path,
        embed_file_attachments=embed_file_attachments,
        rewrite_imports=rewrite_imports,
        variables=variables,
        show_pinned_source=show_pinned_source,
    )
    return _standalone_view(notebook, resolved_view_options)


def view_from_observablehq(
    specifier: str,
    *,
    variables: Mapping[str, object] | None = None,
    files: Mapping[str, FileInput] | None = None,
    show_pinned_source: bool = False,
    timeout: float | None = 30,
    **view_options: Unpack[NotebookViewOptions],
) -> NotebookView:
    """Fetch a public ObservableHQ notebook and return its renderable view.

    Closing the returned view also closes its notebook session. Set
    ``capture_state=False`` to skip browser evaluation readback.

    Examples:
        Create a view from a public ObservableHQ notebook URL:

        >>> import observablejs as obs
        >>> view = obs.view_from_observablehq(
        ...     "https://observablehq.com/@observablehq/plot-vertical-bar-chart"
        ... )
        >>> view.close()

    Runtime and imports:
        ObservableHQ sources use the Observable runtime profile. It provides
        classic ``require``, ``DOM``, ``Files``, ``Generators``, and
        ``Promises`` together with ``Inputs``, ``Plot``, ``d3``,
        ``DuckDBClient``, ``htl``, ``html``, ``svg``, ``md``, ``tex``,
        ``dot``, ``_``, ``aq``, ``Arrow``, ``duckdb``, ``echarts``, ``L``,
        ``mapboxgl``, ``mermaid``, ``React``, ``ReactDOM``, ``topojson``, and
        ``vl``. ``FileAttachment``, ``Mutable``, ``SQLite``,
        ``SQLiteDatabaseClient``, ``width``, ``dark``, and the sample datasets
        are also available. Use these names directly in cells. Most libraries
        and datasets load in the browser when first used.

        Python fetches the initial document through the Observable document
        API. Observable JavaScript imports such as
        ``import {name} from "@observablehq/hello-world"`` load nested
        notebooks through the Observable API. ``require("d3-format@3")`` and
        literal dynamic imports such as ``import("d3-format@3")`` load
        packages from jsDelivr. The fetched document's ``id`` and ``version``
        preserve its nested import resolution.
    """

    resolved_view_options = resolve_notebook_view_options(view_options)
    notebook = Notebook.from_observablehq(
        specifier,
        variables=variables,
        files=files,
        show_pinned_source=show_pinned_source,
        timeout=timeout,
    )
    return _standalone_view(notebook, resolved_view_options)


def view_from_observablehq_document(
    document: ObservableDocument,
    *,
    title: str | None = None,
    variables: Mapping[str, object] | None = None,
    files: Mapping[str, FileInput] | None = None,
    show_pinned_source: bool = False,
    **view_options: Unpack[NotebookViewOptions],
) -> NotebookView:
    """Create a renderable view from an ObservableHQ document API mapping.

    Closing the returned view also closes its notebook session. Set
    ``capture_state=False`` to skip browser evaluation readback.

    Examples:
        Create a view from an ObservableHQ document already in memory:

        >>> import observablejs as obs
        >>> from observablejs.types import ObservableDocument
        >>> document: ObservableDocument = {
        ...     "title": "Metrics",
        ...     "nodes": [
        ...         {"id": 1, "mode": "md", "value": "# Metrics"},
        ...         {
        ...             "id": 2,
        ...             "mode": "js",
        ...             "name": "values",
        ...             "value": "values = [3, 5, 8]",
        ...         },
        ...         {
        ...             "id": 3,
        ...             "mode": "html",
        ...             "value": "<strong>${values.length} values</strong>",
        ...         },
        ...         {
        ...             "id": 4,
        ...             "mode": "tex",
        ...             "value": r"\\sum_{i=1}^{3} x_i",
        ...         },
        ...     ],
        ... }
        >>> view = obs.view_from_observablehq_document(document)
        >>> view.close()

    Runtime and imports:
        ObservableHQ documents use the Observable runtime profile. It provides
        classic ``require``, ``DOM``, ``Files``, ``Generators``, and
        ``Promises`` together with ``Inputs``, ``Plot``, ``d3``,
        ``DuckDBClient``, ``htl``, ``html``, ``svg``, ``md``, ``tex``,
        ``dot``, ``_``, ``aq``, ``Arrow``, ``duckdb``, ``echarts``, ``L``,
        ``mapboxgl``, ``mermaid``, ``React``, ``ReactDOM``, ``topojson``, and
        ``vl``. ``FileAttachment``, ``Mutable``, ``SQLite``,
        ``SQLiteDatabaseClient``, ``width``, ``dark``, and the sample datasets
        are also available. Use these names directly in cells. Most libraries
        and datasets load in the browser when first used.

        Observable JavaScript imports such as
        ``import {name} from "@observablehq/hello-world"`` load nested
        notebooks through the Observable API. ``require("d3-format@3")`` and
        literal dynamic imports such as ``import("d3-format@3")`` load
        packages from jsDelivr. Include the source document's ``id`` and
        ``version`` fields to preserve its nested import resolution.
    """

    resolved_view_options = resolve_notebook_view_options(view_options)
    notebook = Notebook.from_observablehq_document(
        document,
        title=title,
        variables=variables,
        files=files,
        show_pinned_source=show_pinned_source,
    )
    return _standalone_view(notebook, resolved_view_options)
