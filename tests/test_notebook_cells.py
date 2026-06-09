from __future__ import annotations

from typing import Any

import pyobservablejs as obs
import pytest
from helpers import (
    BrowserGraphCellBuilder,
    BrowserGraphSync,
    BrowserValueSync,
    ScriptTags,
)


def test_cell_defaults_to_observable_js_and_dedents(script_tags: ScriptTags) -> None:
    item = obs.ojs(
        """
        answer = 42
        """
    )

    scripts = script_tags(obs.Notebook(item).to_notebook_html())
    assert scripts[0]["attrs"].get("type") == "application/vnd.observable.javascript"
    assert scripts[0]["text"].strip() == "answer = 42"


def test_notebook_rejects_list_wrapped_cells() -> None:
    bad_cells: Any = [obs.ojs("answer = 42")]
    with pytest.raises(TypeError, match="strings or Cell objects"):
        obs.Notebook(bad_cells)


def test_notebook_cell_lookup_returns_child_widget_instances() -> None:
    widget = obs.Notebook(
        obs.md("# Title", name="title"),
        obs.ojs("answer = 42", name="answer"),
        title="Composed",
    )

    assert len(widget.cells) == 2
    assert [widget.cell(index).name for index in range(2)] == ["title", "answer"]
    assert [cell.name for cell in widget.cells] == ["title", "answer"]
    assert widget.cell("answer").name == "answer"
    assert widget.cell(1) is widget.cells[1]
    assert widget.cell("answer") is widget.cells[1]


def test_notebook_graph_exposes_symbolic_cell_metadata(
    browser_graph_sync: BrowserGraphSync,
    browser_graph_cell: BrowserGraphCellBuilder,
) -> None:
    widget = obs.Notebook(
        obs.ojs("a = 1", name="a"),
        obs.ojs("b = a + rows.length", name="b"),
        variables={"rows": [{"x": 1}]},
    )
    browser_graph_sync(
        widget,
        cells=[
            browser_graph_cell(
                "a",
                name="a",
                defines=["a"],
                output="a",
                runtime_outputs=["a"],
            ),
            browser_graph_cell(
                "b",
                name="b",
                defines=["b"],
                references=["a", "rows"],
                output="b",
                runtime_outputs=["b"],
            ),
        ],
        edges=[("a", "b", "a")],
    )

    graph = widget.graph

    assert graph is not None
    assert graph.defines == ("a", "b")
    assert graph.references == ("a", "rows")
    assert graph.external_references == ("rows",)
    assert graph.cell_for_variable("a").name == "a"
    assert graph.cell_for_variable("b").name == "b"
    assert [
        edge.variable
        for edge in graph.edges
        if edge.source_id == graph.cell_for_variable("a").id
        and edge.target_id == graph.cell_for_variable("b").id
    ] == ["a"]
    assert widget.cell("b").defines == ("b",)
    assert widget.cell("b").references == ("a", "rows")
    assert widget.cell("b").outputs == ()
    assert widget.cell("b").runtime_outputs == ("b",)
    assert widget.cell("b").output == "b"


def test_notebook_graph_drops_invalid_browser_entries() -> None:
    widget = obs.Notebook(obs.ojs("answer = 42", name="answer"))
    widget.set_trait(
        "_graph",
        {
            "cells": [
                {
                    "id": 1,
                    "index": 0,
                    "mode": "ojs",
                    "name": "answer",
                    "defines": ["answer"],
                },
                {"id": "bad", "index": 1, "mode": ""},
            ],
            "edges": [
                {"from": 1, "to": 2, "variable": "missing-target"},
                {"from": "bad", "to": 1, "variable": "bad-source"},
                {"from": 1, "to": 1, "variable": ""},
            ],
        },
    )

    graph = widget.graph

    assert graph is not None
    assert [cell.defines for cell in graph.cells] == [("answer",)]
    assert graph.edges == ()


def test_cell_lookup_can_use_unique_graph_output(
    browser_graph_sync: BrowserGraphSync,
    browser_graph_cell: BrowserGraphCellBuilder,
) -> None:
    widget = obs.Notebook(
        obs.ojs("answer = 42"),
        obs.ojs("answer + 1", name="readout"),
    )
    browser_graph_sync(
        widget,
        cells=[
            browser_graph_cell(
                "answer-cell",
                defines=["answer"],
                output="answer",
                runtime_outputs=["answer"],
            )
        ],
    )

    with pytest.raises(KeyError, match="Unknown Observable cell name"):
        widget.cell("answer")
    assert widget.cell_for_variable("answer") is widget.cells[0]
    assert widget.cell_for_variable("answer").defines == ("answer",)


def test_cell_lookup_rejects_ambiguous_graph_variable(
    browser_graph_sync: BrowserGraphSync,
    browser_graph_cell: BrowserGraphCellBuilder,
) -> None:
    widget = obs.Notebook(
        obs.ojs("answer = 42"),
        obs.ojs("answer = 43"),
    )
    browser_graph_sync(
        widget,
        cells=[
            browser_graph_cell("first-answer", defines=["answer"]),
            browser_graph_cell("second-answer", defines=["answer"]),
        ],
    )

    with pytest.raises(KeyError, match="Ambiguous Observable variable"):
        widget.cell_for_variable("answer")


def test_cell_lookup_separates_python_name_from_ojs_variable(
    browser_graph_sync: BrowserGraphSync,
    browser_graph_cell: BrowserGraphCellBuilder,
) -> None:
    widget = obs.Notebook(
        obs.ojs("alpha = 1", name="conflict"),
        obs.ojs("conflict = 2", name="other"),
    )
    browser_graph_sync(
        widget,
        cells=[
            browser_graph_cell("python-name", defines=["alpha"]),
            browser_graph_cell("ojs-variable", defines=["conflict"]),
        ],
    )

    assert widget.cell("conflict").defines == ("alpha",)
    assert widget.cell_for_variable("conflict").name == "other"
    assert widget.cell_for_variable("conflict").defines == ("conflict",)


def test_named_notebook_cells_expose_values(
    browser_value_sync: BrowserValueSync,
) -> None:
    widget = obs.Notebook(obs.ojs("viewof gain = Inputs.range([0, 11])", name="gain"))
    cell_widget = widget.cell("gain")

    browser_value_sync(cell_widget, {"gain": 7}, ["gain", "doubled"])

    assert cell_widget.value == 7
    assert cell_widget.values == {"gain": 7}
    assert widget.value("gain") == 7
    assert widget.values == {"gain": 7}


def test_cell_value_error_points_to_values_mapping(
    browser_value_sync: BrowserValueSync,
) -> None:
    cell_widget = obs.Notebook(obs.ojs("answer = 42", name="cell")).cell("cell")
    browser_value_sync(cell_widget, {"answer": 42, "double": 84})

    with pytest.raises(KeyError, match=r"cell\.values\[name\]"):
        _ = cell_widget.value


def test_browser_values_are_exposed_to_notebook_values(
    browser_value_sync: BrowserValueSync,
) -> None:
    widget = obs.Notebook(obs.ojs("viewof gain = Inputs.range([0, 11])", name="gain"))

    browser_value_sync(widget, {"gain": 8}, ["gain"])

    assert widget.values == {"gain": 8}
    assert widget.value("gain") == 8
    assert widget.value_names == ("gain",)


def test_script_end_tag_literal_stays_inside_script_cell(
    script_tags: ScriptTags,
) -> None:
    source = "html`</script></SCRIPT>`"
    widget = obs.Notebook(obs.ojs(source))

    scripts = script_tags(widget.to_notebook_html())

    assert len(scripts) == 1
    assert scripts[0]["attrs"].get("type") == "application/vnd.observable.javascript"
    text = scripts[0]["text"].strip()
    assert text == "html`<\\/script><\\/script>`"
