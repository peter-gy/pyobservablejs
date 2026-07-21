"""Standalone factories for renderable notebook views."""

from __future__ import annotations

import pathlib
from collections.abc import Mapping

from ._cells import Cell
from ._notebook import Notebook, NotebookView
from .types import CellMode, FileInput, ObservableDocument, Theme


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
    cell language.
    """

    return Notebook(
        Cell(code, mode=mode),
        title=title,
        theme=theme,
        files=files,
        base_path=base_path,
        variables=variables,
    ).view()


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
    """Create an AnyWidget view from Notebook Kit HTML text."""

    return Notebook.from_html(
        source,
        files=files,
        base_path=base_path,
        embed_file_attachments=embed_file_attachments,
        rewrite_imports=rewrite_imports,
        variables=variables,
        show_pinned_source=show_pinned_source,
    ).view()


def view_from_observablehq(
    specifier: str,
    *,
    variables: Mapping[str, object] | None = None,
    files: Mapping[str, FileInput] | None = None,
    show_pinned_source: bool = False,
    timeout: float | None = 30,
) -> NotebookView:
    """Fetch a public ObservableHQ notebook and return its AnyWidget view."""

    return Notebook.from_observablehq(
        specifier,
        variables=variables,
        files=files,
        show_pinned_source=show_pinned_source,
        timeout=timeout,
    ).view()


def view_from_observablehq_document(
    document: ObservableDocument,
    *,
    title: str | None = None,
    variables: Mapping[str, object] | None = None,
    files: Mapping[str, FileInput] | None = None,
    show_pinned_source: bool = False,
) -> NotebookView:
    """Create an AnyWidget view from an ObservableHQ document API mapping."""

    return Notebook.from_observablehq_document(
        document,
        title=title,
        variables=variables,
        files=files,
        show_pinned_source=show_pinned_source,
    ).view()
