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

    Closing the returned view also closes its notebook session.

    Examples:
        Create a view from stored Notebook Kit HTML:

        >>> import observablejs as obs
        >>> source = (
        ...     '<notebook theme="air">'
        ...     '<script id="1" '
        ...     'type="application/vnd.observable.javascript">'
        ...     'answer = 42</script></notebook>'
        ... )
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
        ...         {
        ...             "id": 1,
        ...             "mode": "js",
        ...             "name": "answer",
        ...             "value": "answer = 42",
        ...         }
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
