from __future__ import annotations

import anywidget
import observablejs as obs
from helpers import (
    DocumentTitle,
    ObservableHQResponseInstaller,
    ScriptTags,
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
    )

    try:
        assert isinstance(view, anywidget.AnyWidget)
        assert isinstance(view, obs.NotebookView)
        assert view.cells == view.notebook.cells
        assert view.notebook.variables == {"rows": ({"value": 1},)}
        assert view.notebook.theme == "coffee"
        assert view.notebook.attachments["data.csv"]["url"] == (
            "https://example.test/data.csv"
        )
        source = view.notebook.to_notebook_html()
        assert document_title(source) == "Code view"
        assert script_tags(source)[0]["attrs"]["type"] == "module"
    finally:
        view.notebook.close()


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
    )
    document_view = obs.view_from_observablehq_document(
        {
            "title": "Remote",
            "nodes": [
                {"id": 1, "mode": "js", "name": "answer", "value": "answer = 42"}
            ],
        }
    )

    try:
        for view in (html_view, document_view):
            assert isinstance(view, anywidget.AnyWidget)
            assert isinstance(view, obs.NotebookView)
            assert view.cells == view.notebook.cells
            assert view.cells[0].key == "answer"
        assert html_view.notebook.variables == {"precision": 2}
        assert document_title(document_view.notebook.to_notebook_html()) == "Remote"
    finally:
        html_view.notebook.close()
        document_view.notebook.close()


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
    )

    try:
        assert isinstance(view, anywidget.AnyWidget)
        assert isinstance(view, obs.NotebookView)
        assert view.cells == view.notebook.cells
        assert view.cells[0].key == "answer"
        assert requests == [("https://api.observablehq.com/document/@d3/bar-chart", 1)]
    finally:
        view.notebook.close()
