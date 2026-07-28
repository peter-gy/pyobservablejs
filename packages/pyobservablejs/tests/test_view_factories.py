from __future__ import annotations

from typing import Any, cast

import anywidget
import observablejs as obs
import pytest
from helpers import (
    DocumentTitle,
    ObservableHQResponseInstaller,
    ScriptTags,
    notebook_session,
)


def test_view_from_code_returns_full_anywidget_view(
    document_title: DocumentTitle,
    script_tags: ScriptTags,
) -> None:
    view = obs.view_from_code(
        "answer = rows.length",
        mode="js",
        title="Code view",
        theme="coffee",
        files={"data.csv": "https://example.test/data.csv"},
        variables={"rows": [{"value": 1}]},
        capture_state=False,
    )
    session = notebook_session(view.notebook)

    try:
        assert isinstance(view, anywidget.AnyWidget)
        assert isinstance(view, obs.NotebookView)
        assert view.cells == view.notebook.cells
        assert view.notebook.variables == {"rows": ({"value": 1},)}
        assert view.notebook.theme == "coffee"
        assert view.notebook.attachments["data.csv"]["url"] == (
            "https://example.test/data.csv"
        )
        assert view.get_state(["_capture_state"]) == {"_capture_state": False}
        source = view.notebook.to_notebook_html()
        assert document_title(source) == "Code view"
        assert script_tags(source)[0]["attrs"]["type"] == "module"
    finally:
        view.close()

    assert session.comm is None


def test_imported_source_factories_return_full_anywidget_views(
    document_title: DocumentTitle,
) -> None:
    html_view = obs.view_from_html(
        """<!doctype html>
<notebook theme="air">
  <script id="1" type="application/vnd.observable.javascript"
    data-pyobservablejs-key="answer">answer = 42</script>
</notebook>
""",
        variables={"precision": 2},
        capture_state=False,
    )
    document_view = obs.view_from_observablehq_document(
        {
            "title": "Remote",
            "nodes": [
                {"id": 1, "mode": "js", "name": "answer", "value": "answer = 42"}
            ],
        },
        capture_state=False,
    )
    sessions = [
        notebook_session(html_view.notebook),
        notebook_session(document_view.notebook),
    ]

    try:
        for view in (html_view, document_view):
            assert isinstance(view, anywidget.AnyWidget)
            assert isinstance(view, obs.NotebookView)
            assert view.cells == view.notebook.cells
            assert view.cells[0].key == "answer"
            assert view.get_state(["_capture_state"]) == {"_capture_state": False}
        assert html_view.notebook.variables == {"precision": 2}
        assert document_title(document_view.notebook.to_notebook_html()) == "Remote"
    finally:
        html_view.close()
        document_view.close()

    assert all(session.comm is None for session in sessions)


def test_view_from_observablehq_accepts_url_factory_input(
    observablehq_response: ObservableHQResponseInstaller,
) -> None:
    requests = observablehq_response(
        {
            "title": "Remote",
            "nodes": [
                {"id": 1, "mode": "js", "name": "answer", "value": "answer = 42"}
            ],
        }
    )

    view = obs.view_from_observablehq(
        "https://observablehq.com/@d3/bar-chart",
        timeout=1,
        capture_state=False,
    )
    session = notebook_session(view.notebook)

    try:
        assert isinstance(view, anywidget.AnyWidget)
        assert isinstance(view, obs.NotebookView)
        assert view.cells == view.notebook.cells
        assert view.cells[0].key == "answer"
        assert view.get_state(["_capture_state"]) == {"_capture_state": False}
        assert requests == [("https://api.observablehq.com/document/@d3/bar-chart", 1)]
    finally:
        view.close()

    assert session.comm is None


@pytest.mark.parametrize(
    ("view_options", "message"),
    [
        pytest.param(
            {"capture_state": "no"},
            "capture_state must be a boolean",
            id="invalid-value",
        ),
        pytest.param(
            {"unknown": True},
            "unexpected Notebook view option 'unknown'",
            id="unknown-option",
        ),
    ],
)
def test_view_factory_validates_options_before_network_request(
    observablehq_response: ObservableHQResponseInstaller,
    view_options: dict[str, object],
    message: str,
) -> None:
    requests = observablehq_response(
        {
            "title": "Remote",
            "nodes": [
                {"id": 1, "mode": "js", "name": "answer", "value": "answer = 42"}
            ],
        }
    )

    with pytest.raises(TypeError, match=message):
        obs.view_from_observablehq(
            "https://observablehq.com/@d3/bar-chart",
            **cast(Any, view_options),
        )

    assert requests == []


def test_view_factory_closes_temporary_notebook_when_view_creation_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    notebooks: list[obs.Notebook] = []

    def fail_view_creation(
        notebook: obs.Notebook,
        *args: object,
        **kwargs: object,
    ) -> object:
        del args, kwargs
        notebooks.append(notebook)
        raise RuntimeError("view creation failed")

    monkeypatch.setattr(obs.Notebook, "_create_view", fail_view_creation)

    with pytest.raises(RuntimeError, match="view creation failed"):
        obs.view_from_code("answer = 42")

    assert len(notebooks) == 1
    assert notebook_session(notebooks[0]).comm is None
