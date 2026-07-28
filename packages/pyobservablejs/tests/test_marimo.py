from __future__ import annotations

import sys

import marimo
import observablejs as obs
import pytest


def test_notebook_view_is_a_marimo_ui_element_in_marimo(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(marimo, "running_in_notebook", lambda: True)
    notebook = obs.Notebook(obs.ojs("answer = 42", key="answer"))

    view = notebook.view(capture_state=False)

    assert isinstance(view, marimo.ui.anywidget)
    assert isinstance(view.widget, obs.NotebookView)
    assert view.notebook is notebook
    assert view.cells == notebook.cells
    assert view.widget.get_state(["_capture_state"]) == {"_capture_state": False}

    view.close()
    sibling = notebook.view()
    sibling.close()
    notebook.close()


def test_standalone_marimo_view_keeps_notebook_ownership(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(marimo, "running_in_notebook", lambda: True)
    view = obs.view_from_code("answer = 42")
    notebook = view.notebook

    view.close()

    with pytest.raises(RuntimeError, match="closed"):
        notebook.view()


def test_notebook_view_stays_an_anywidget_outside_marimo(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(marimo, "running_in_notebook", lambda: False)
    view = obs.Notebook().view()

    assert isinstance(view, obs.NotebookView)
    view.close()


def test_notebook_view_stays_an_anywidget_when_marimo_is_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(sys.modules, "marimo", None)
    view = obs.Notebook().view()

    assert isinstance(view, obs.NotebookView)
    view.close()
