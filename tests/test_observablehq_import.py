from __future__ import annotations

import pyobservablejs as obs
import pytest
from helpers import DocumentTitle, ObservableHQResponseInstaller, ScriptTags


@pytest.mark.parametrize(
    ("specifier", "api_url"),
    [
        (
            "https://observablehq.com/@d3/bar-chart",
            "https://api.observablehq.com/document/@d3/bar-chart",
        ),
        (
            "https://observablehq.com/@d3/bar-chart/2",
            "https://api.observablehq.com/document/@d3/bar-chart/2",
        ),
        (
            "https://observablehq.com/@d3/bar-chart@latest",
            "https://api.observablehq.com/document/@d3/bar-chart@latest",
        ),
        (
            "https://observablehq.com/d/1234567890abcdef",
            "https://api.observablehq.com/document/1234567890abcdef",
        ),
        (
            "https://api.observablehq.com/document/@d3/bar-chart",
            "https://api.observablehq.com/document/@d3/bar-chart",
        ),
        (
            "https://api.observablehq.com/document/1234567890abcdef",
            "https://api.observablehq.com/document/1234567890abcdef",
        ),
        ("@d3/bar-chart", "https://api.observablehq.com/document/@d3/bar-chart"),
        (
            "1234567890abcdef",
            "https://api.observablehq.com/document/1234567890abcdef",
        ),
    ],
)
def test_observablehq_specifier_resolution_matches_document_api(
    observablehq_response: ObservableHQResponseInstaller,
    specifier: str,
    api_url: str,
) -> None:
    requests = observablehq_response({"title": "Remote", "nodes": []})

    obs.Notebook.from_observablehq(specifier, timeout=1)

    assert requests == [(api_url, 1)]


def test_observablehq_rejects_non_observable_specifier() -> None:
    with pytest.raises(ValueError, match="Invalid ObservableHQ notebook specifier"):
        obs.Notebook.from_observablehq("https://example.com/@d3/bar-chart")


def test_notebook_from_observablehq_fetches_source_and_remote_attachments(
    observablehq_response: ObservableHQResponseInstaller,
    script_tags: ScriptTags,
    document_title: DocumentTitle,
) -> None:
    observablehq_response(
        {
            "title": "Remote",
            "nodes": [{"id": 1, "mode": "js", "value": "answer = 42"}],
            "files": [
                {
                    "name": "data.csv",
                    "download_url": "https://static.example/data.csv",
                }
            ],
        }
    )

    widget = obs.Notebook.from_observablehq(
        "https://observablehq.com/@d3/bar-chart",
        timeout=1,
        attachments={"local.csv": "https://example.test/local.csv"},
    )

    source = widget.to_notebook_html()
    scripts = script_tags(source)
    assert document_title(source) == "Remote"
    assert scripts[0]["attrs"].get("type") == "application/vnd.observable.javascript"
    assert scripts[0]["text"].strip() == "answer = 42"
    assert set(widget.attachments) == {"data.csv", "local.csv"}
    assert widget.attachments["data.csv"]["url"] == "https://static.example/data.csv"
    assert widget.attachments["local.csv"]["url"] == "https://example.test/local.csv"
    assert len(widget.cells) == 1


def test_notebook_from_observablehq_converts_table_nodes(
    observablehq_response: ObservableHQResponseInstaller,
    script_tags: ScriptTags,
) -> None:
    observablehq_response(
        {
            "title": "Remote",
            "nodes": [
                {"id": 1, "mode": "js", "name": "rows", "value": "rows = []"},
                {
                    "id": 2,
                    "mode": "table",
                    "pinned": True,
                    "data": {"source": {"type": "cell", "name": "rows"}},
                },
            ],
        }
    )

    widget = obs.Notebook.from_observablehq("@d3/table-view", timeout=1)

    scripts = script_tags(widget.to_notebook_html())
    assert scripts[1]["attrs"].get("type") == "application/vnd.observable.javascript"
    assert "pinned" in scripts[1]["attrs"]
    assert scripts[1]["text"].strip() == "Inputs.table(await rows)"
    assert len(widget.cells) == 2


def test_notebook_from_observablehq_converts_named_file_table_nodes(
    observablehq_response: ObservableHQResponseInstaller,
    script_tags: ScriptTags,
) -> None:
    observablehq_response(
        {
            "title": "Remote",
            "nodes": [
                {
                    "id": 1,
                    "mode": "table",
                    "name": "worldbank",
                    "pinned": True,
                    "data": {
                        "source": {
                            "type": "FileAttachment",
                            "name": "wb_tidy.csv",
                        },
                        "display": {"mode": "none"},
                    },
                },
            ],
        }
    )

    widget = obs.Notebook.from_observablehq("@d3/table-view", timeout=1)

    scripts = script_tags(widget.to_notebook_html())
    assert scripts[0]["attrs"].get("type") == "application/vnd.observable.javascript"
    assert scripts[0]["attrs"].get("name") == "worldbank"
    assert "hidden" in scripts[0]["attrs"]
    assert scripts[0]["text"].strip() == (
        'viewof worldbank = Inputs.table(await FileAttachment("wb_tidy.csv").csv({typed: true}))'
    )
    assert widget.cells[0].name == "worldbank"


def test_notebook_from_observablehq_converts_empty_table_nodes(
    observablehq_response: ObservableHQResponseInstaller,
    script_tags: ScriptTags,
) -> None:
    observablehq_response(
        {
            "title": "Remote",
            "nodes": [
                {
                    "id": 1,
                    "mode": "table",
                    "data": {
                        "source": {"type": None, "name": None},
                        "operations": {"from": {"table": None}},
                    },
                },
            ],
        }
    )

    widget = obs.Notebook.from_observablehq("@d3/table-view", timeout=1)

    scripts = script_tags(widget.to_notebook_html())
    assert scripts[0]["text"].strip() == "Inputs.table(await [])"
    assert len(widget.cells) == 1


def test_notebook_from_observablehq_converts_chart_nodes_to_plot_auto(
    observablehq_response: ObservableHQResponseInstaller,
    script_tags: ScriptTags,
) -> None:
    observablehq_response(
        {
            "title": "Remote",
            "nodes": [
                {
                    "id": 1,
                    "mode": "chart",
                    "name": "revenueChart",
                    "pinned": True,
                    "data": {
                        "source": {"type": "cell", "name": "orders"},
                        "config": {
                            "x": {"type": "field", "value": "order_date"},
                            "y": {"type": "field", "value": "revenue"},
                            "fx": {"type": "undefined"},
                            "fy": {"type": "field", "value": "category"},
                            "mark": {"type": "constant", "value": "area"},
                            "size": {"type": "undefined"},
                            "color": {"type": "field", "value": "category"},
                            "options": {"marginLeft": 60},
                        },
                    },
                },
            ],
        }
    )

    widget = obs.Notebook.from_observablehq("@d3/chart-view", timeout=1)

    scripts = script_tags(widget.to_notebook_html())
    assert scripts[0]["attrs"].get("type") == "application/vnd.observable.javascript"
    assert scripts[0]["attrs"].get("name") == "revenueChart"
    assert scripts[0]["text"].strip() == (
        'revenueChart = Plot.auto(await orders, {"x": "order_date", "y": "revenue", '
        '"fy": "category", "color": "category", "mark": "area", "marginLeft": 60}).plot()'
    )
    assert widget.cells[0].name == "revenueChart"


def test_notebook_from_observablehq_converts_empty_chart_nodes(
    observablehq_response: ObservableHQResponseInstaller,
    script_tags: ScriptTags,
) -> None:
    observablehq_response(
        {
            "title": "Remote",
            "nodes": [
                {
                    "id": 1,
                    "mode": "chart",
                    "data": {
                        "source": {"type": None, "name": None},
                        "config": {
                            "x": {"type": "undefined"},
                            "y": {"type": "undefined"},
                            "fx": {"type": "undefined"},
                            "fy": {"type": "undefined"},
                            "mark": {"type": "undefined"},
                            "size": {"type": "undefined"},
                            "color": {"type": "undefined"},
                            "options": {},
                        },
                    },
                },
            ],
        }
    )

    widget = obs.Notebook.from_observablehq("@d3/chart-view", timeout=1)

    scripts = script_tags(widget.to_notebook_html())
    assert scripts[0]["text"].strip() == "Plot.auto(await [], {}).plot()"
    assert len(widget.cells) == 1


def test_notebook_from_observablehq_accepts_initial_variables(
    observablehq_response: ObservableHQResponseInstaller,
    script_tags: ScriptTags,
) -> None:
    requests = observablehq_response(
        {
            "title": "Remote",
            "nodes": [{"id": 1, "mode": "js", "value": "py_answer + 1"}],
        }
    )

    widget = obs.Notebook.from_observablehq(
        "@d3/bar-chart",
        timeout=1,
        variables={"py_answer": 7},
    )

    scripts = script_tags(widget.to_notebook_html())
    assert requests == [("https://api.observablehq.com/document/@d3/bar-chart", 1)]
    assert scripts[0]["text"].strip() == "py_answer + 1"
    assert widget.variables == {"py_answer": 7}


def test_notebook_from_observablehq_initial_variables_serialize_to_frontend_state(
    observablehq_response: ObservableHQResponseInstaller,
    script_tags: ScriptTags,
) -> None:
    requests = observablehq_response(
        {
            "title": "Remote",
            "nodes": [{"id": 1, "mode": "js", "value": "py_answer + 1"}],
        }
    )

    widget = obs.Notebook.from_observablehq(
        "@d3/bar-chart",
        timeout=1,
        variables={"py_answer": 7},
    )

    scripts = script_tags(widget.to_notebook_html())
    assert requests == [("https://api.observablehq.com/document/@d3/bar-chart", 1)]
    assert scripts[0]["text"].strip() == "py_answer + 1"
    assert widget.get_state(["_variables"])["_variables"] == {"py_answer": 7}
