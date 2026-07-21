"""Standalone factories for renderable notebook views."""

from __future__ import annotations

import pathlib
from collections.abc import Mapping

from ._cells import Cell
from ._notebook import Notebook, NotebookView
from .types import CellMode, FileInput, ObservableDocument, Theme


def _standalone_view(notebook: Notebook) -> NotebookView:
    view = notebook.view()
    view._owns_notebook = True
    return view


def view_from_code(
    code: str,
    *,
    mode: CellMode = "ojs",
    title: str = "Untitled",
    theme: Theme = "air",
    files: Mapping[str, FileInput] | None = None,
    base_path: str | pathlib.Path | None = None,
    variables: Mapping[str, object] | None = None,
) -> NotebookView:
    """Create an AnyWidget view from one Notebook Kit source cell.

    The code uses Observable JavaScript by default. Set mode to select another
    cell language. Closing the returned view also closes its notebook session.

    Examples:
        Create a slider view from one Observable JavaScript cell:

        >>> import observablejs as obs
        >>> view = obs.view_from_code(
        ...     "viewof quantity = Inputs.range([0, 100], {step: 1})"
        ... )
        >>> view.close()
    """

    notebook = Notebook(
        Cell(code, mode=mode),
        title=title,
        theme=theme,
        files=files,
        base_path=base_path,
        variables=variables,
    )
    return _standalone_view(notebook)


def view_from_html(
    source: str,
    *,
    files: Mapping[str, FileInput] | None = None,
    base_path: str | pathlib.Path | None = None,
    embed_file_attachments: bool = False,
    rewrite_imports: bool = False,
    variables: Mapping[str, object] | None = None,
    show_pinned_source: bool = False,
) -> NotebookView:
    """Create an AnyWidget view from Notebook Kit HTML text.

    The HTML can mix Notebook Kit cell types. See the official Notebook Kit
    documentation at https://observablehq.com/notebook-kit/kit for the file
    format and cell type details.

    Closing the returned view also closes its notebook session.

    Examples:
        Create a view containing each Notebook Kit cell type:

        >>> import observablejs as obs
        >>> source = r'''
        ... <!doctype html>
        ... <notebook theme="air">
        ...   <title>Cell types</title>
        ...   <script id="1" type="text/markdown">
        ...     # Cell types
        ...   </script>
        ...   <script id="2" type="module">
        ...     const values = [1, 2, 3];
        ...     const db = DuckDBClient.of({values: values.map(value => ({value}))});
        ...   </script>
        ...   <script id="3" type="text/x-typescript">
        ...     const total: number = values.reduce((sum, value) => sum + value, 0);
        ...   </script>
        ...   <script id="4" type="application/vnd.observable.javascript">
        ...     viewof limit = Inputs.range([1, 10], {value: total})
        ...   </script>
        ...   <script id="5" type="text/html">
        ...     <strong>Selected limit: ${limit}</strong>
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
        ...   <script id="9" type="application/vnd.node.javascript"
        ...           format="json" output="node_data">
        ...     process.stdout.write(JSON.stringify({runtime: "node"}));
        ...   </script>
        ...   <script id="10" type="text/x-python"
        ...           format="json" output="python_data">
        ...     import json, sys
        ...     json.dump({"runtime": "python"}, sys.stdout)
        ...   </script>
        ...   <script id="11" type="text/x-r"
        ...           format="json" output="r_data">
        ...     cat('{"runtime":"r"}')
        ...   </script>
        ... </notebook>
        ... '''
        >>> view = obs.view_from_html(source)
        >>> view.close()
    """

    notebook = Notebook.from_html(
        source,
        files=files,
        base_path=base_path,
        embed_file_attachments=embed_file_attachments,
        rewrite_imports=rewrite_imports,
        variables=variables,
        show_pinned_source=show_pinned_source,
    )
    return _standalone_view(notebook)


def view_from_observablehq(
    specifier: str,
    *,
    variables: Mapping[str, object] | None = None,
    files: Mapping[str, FileInput] | None = None,
    show_pinned_source: bool = False,
    timeout: float | None = 30,
) -> NotebookView:
    """Fetch a public ObservableHQ notebook and return its AnyWidget view.

    Closing the returned view also closes its notebook session.

    Examples:
        Create a view from a public ObservableHQ notebook URL:

        >>> import observablejs as obs
        >>> view = obs.view_from_observablehq(
        ...     "https://observablehq.com/@d3/bar-chart"
        ... )
        >>> view.close()
    """

    notebook = Notebook.from_observablehq(
        specifier,
        variables=variables,
        files=files,
        show_pinned_source=show_pinned_source,
        timeout=timeout,
    )
    return _standalone_view(notebook)


def view_from_observablehq_document(
    document: ObservableDocument,
    *,
    title: str | None = None,
    variables: Mapping[str, object] | None = None,
    files: Mapping[str, FileInput] | None = None,
    show_pinned_source: bool = False,
) -> NotebookView:
    """Create an AnyWidget view from an ObservableHQ document API mapping.

    Closing the returned view also closes its notebook session.

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
    """

    notebook = Notebook.from_observablehq_document(
        document,
        title=title,
        variables=variables,
        files=files,
        show_pinned_source=show_pinned_source,
    )
    return _standalone_view(notebook)
