from __future__ import annotations

import json
import re
from typing import Any

import observablejs as obs
import pytest
import traitlets
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
    with pytest.raises(TypeError, match="obs.ojs"):
        obs.Notebook(bad_cells)


def test_notebook_returns_stable_cell_handles() -> None:
    widget = obs.Notebook(
        obs.md("# Title", key="title"),
        obs.ojs("answer = 42", key="answer"),
        title="Composed",
    )

    answer = widget.cell_at(1)
    assert widget.cell_at(1) is answer
    assert widget.cell_by_key("answer") is answer
    assert len(widget.cells) == 2
    assert [widget.cell_at(index).key for index in range(2)] == ["title", "answer"]
    assert [cell.key for cell in widget.cells] == ["title", "answer"]
    assert [cell.name for cell in widget.cells] == ["", ""]
    assert widget.cell_by_key("answer").key == "answer"
    assert answer is widget.cells[1]


def test_notebook_cell_display_creates_a_fresh_model() -> None:
    widget = obs.Notebook(
        obs.md("# Title", key="title"),
        obs.ojs("answer = 42", key="answer"),
    )

    cell = widget.cell_at(1)
    first_id = _widget_model_id(cell._repr_mimebundle_())
    second_id = _widget_model_id(cell._repr_mimebundle_())

    assert first_id != second_id


def test_notebook_cell_display_serializes_its_parent_reference() -> None:
    widget = obs.Notebook(
        obs.md("# Title", key="title"),
        obs.ojs("answer = 42", key="answer"),
    )
    cell = widget._new_cell_view(1)
    state = cell.get_state(["_notebook_widget", "_notebook_index"])

    assert cell._notebook_widget is widget
    assert state["_notebook_widget"] == f"anywidget:{widget.model_id}"
    assert state["_notebook_index"] == 1


def test_notebook_cell_parent_reference_rejects_browser_wire_state() -> None:
    widget = obs.Notebook(obs.ojs("answer = 42", key="answer"))
    cell = widget._new_cell_view(0)
    ref = f"anywidget:{widget.model_id}"

    with pytest.raises(traitlets.TraitError, match="expected a Notebook"):
        cell.set_state({"_notebook_widget": ref})

    assert cell._notebook_widget is widget


def test_notebook_graph_exposes_symbolic_cell_metadata(
    browser_graph_sync: BrowserGraphSync,
    browser_graph_cell: BrowserGraphCellBuilder,
) -> None:
    widget = obs.Notebook(
        obs.ojs("a = 1", key="a"),
        obs.ojs("b = a + rows.length", key="b"),
        variables={"rows": [{"x": 1}]},
    )
    browser_graph_sync(
        widget,
        cells=[
            browser_graph_cell(
                "a",
                defines=["a"],
                output="a",
                runtime_outputs=["a"],
            ),
            browser_graph_cell(
                "b",
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
    assert graph.cell_for_variable("a").key == "a"
    assert graph.cell_for_variable("b").key == "b"
    assert [
        edge.variable
        for edge in graph.edges
        if edge.source_id == graph.cell_for_variable("a").id
        and edge.target_id == graph.cell_for_variable("b").id
    ] == ["a"]
    assert widget.cell_by_key("b").defines == ("b",)
    assert widget.cell_by_key("b").references == ("a", "rows")
    assert widget.cell_by_key("b").outputs == ()
    assert widget.cell_by_key("b").runtime_outputs == ("b",)
    assert widget.cell_by_key("b").output == "b"


def test_notebook_graph_exports_mermaid_dependency_diagram(
    browser_graph_sync: BrowserGraphSync,
    browser_graph_cell: BrowserGraphCellBuilder,
) -> None:
    widget = obs.Notebook(
        obs.ojs("a = 1", key="alpha"),
        obs.ojs("b = a + rows.length", key="beta"),
        variables={"rows": [{"x": 1}]},
    )
    browser_graph_sync(
        widget,
        cells=[
            browser_graph_cell("alpha", defines=["a"], output="a"),
            browser_graph_cell(
                "beta",
                defines=["b"],
                references=["a", "rows"],
                output="b",
            ),
        ],
        edges=[("alpha", "beta", "a")],
    )

    direction, nodes, edges = _mermaid_topology(widget.graph.to_mermaid())

    assert direction == "LR"
    assert nodes == {
        "Cell 0: alpha, defines: a",
        "Cell 1: beta, defines: b",
        "external: rows",
    }
    assert edges == {
        ("Cell 0: alpha, defines: a", "a", "Cell 1: beta, defines: b"),
        ("external: rows", "rows", "Cell 1: beta, defines: b"),
    }


def test_notebook_graph_exports_d2_dependency_diagram(
    browser_graph_sync: BrowserGraphSync,
    browser_graph_cell: BrowserGraphCellBuilder,
) -> None:
    widget = obs.Notebook(
        obs.ojs("a = 1", key="alpha"),
        obs.ojs("b = a + rows.length", key="beta"),
        variables={"rows": [{"x": 1}]},
    )
    browser_graph_sync(
        widget,
        cells=[
            browser_graph_cell("alpha", defines=["a"], output="a"),
            browser_graph_cell(
                "beta",
                defines=["b"],
                references=["a", "rows"],
                output="b",
            ),
        ],
        edges=[("alpha", "beta", "a")],
    )

    direction, nodes, edges = _d2_topology(widget.graph.to_d2())

    assert direction == "right"
    assert nodes == {
        "Cell 0: alpha, defines: a",
        "Cell 1: beta, defines: b",
        "external: rows",
    }
    assert edges == {
        ("Cell 0: alpha, defines: a", "a", "Cell 1: beta, defines: b"),
        ("external: rows", "rows", "Cell 1: beta, defines: b"),
    }


def test_notebook_graph_diagram_exports_escape_labels(
    browser_graph_sync: BrowserGraphSync,
    browser_graph_cell: BrowserGraphCellBuilder,
) -> None:
    widget = obs.Notebook(
        obs.ojs("answer = 42", key='quote " cell'),
        obs.ojs("answer + row_count", key="readout"),
    )
    browser_graph_sync(
        widget,
        cells=[
            browser_graph_cell('quote " cell', defines=['answer "1"'], output="answer"),
            browser_graph_cell(
                "readout",
                defines=["result"],
                references=['answer "1"', "row|count"],
                output="result",
            ),
        ],
        edges=[('quote " cell', "readout", 'answer "1"')],
    )

    mermaid_direction, mermaid_nodes, mermaid_edges = _mermaid_topology(
        widget.graph.to_mermaid()
    )
    escaped_first_label = "Cell 0: quote #quot; cell, defines: answer #quot;1#quot;"
    escaped_target_label = "Cell 1: readout, defines: result"
    assert mermaid_direction == "LR"
    assert escaped_first_label in mermaid_nodes
    assert (
        escaped_first_label,
        "answer #quot;1#quot;",
        escaped_target_label,
    ) in mermaid_edges
    assert (
        "external: row#124;count",
        "row#124;count",
        escaped_target_label,
    ) in mermaid_edges

    d2_direction, d2_nodes, d2_edges = _d2_topology(widget.graph.to_d2())
    first_label = 'Cell 0: quote " cell, defines: answer "1"'
    target_label = "Cell 1: readout, defines: result"
    assert d2_direction == "right"
    assert first_label in d2_nodes
    assert (first_label, 'answer "1"', target_label) in d2_edges
    assert ("external: row|count", "row|count", target_label) in d2_edges


_MERMAID_NODE = re.compile(r'^([A-Za-z][\w-]*)\["(.*)"\]$')
_MERMAID_EDGE = re.compile(r"^([A-Za-z][\w-]*)\s*-->\|(.*)\|\s*([A-Za-z][\w-]*)$")
_D2_NODE = re.compile(r"^([A-Za-z][\w-]*)\s*:\s*(.+)$")
_D2_EDGE = re.compile(r"^([A-Za-z][\w-]*)\s*->\s*([A-Za-z][\w-]*)\s*:\s*(.+)$")


def _mermaid_topology(
    source: str,
) -> tuple[str, set[str], set[tuple[str, str, str]]]:
    lines = [line.strip() for line in source.splitlines() if line.strip()]
    header = lines[0].split()
    assert header[:1] == ["flowchart"]
    assert len(header) == 2

    node_labels: dict[str, str] = {}
    raw_edges: list[tuple[str, str, str]] = []
    for line in lines[1:]:
        if node := _MERMAID_NODE.fullmatch(line):
            node_labels[node.group(1)] = node.group(2)
        elif edge := _MERMAID_EDGE.fullmatch(line):
            raw_edges.append((edge.group(1), edge.group(2), edge.group(3)))
        else:
            raise AssertionError(f"Unrecognized Mermaid statement: {line}")

    edges = {
        (node_labels[source_id], label, node_labels[target_id])
        for source_id, label, target_id in raw_edges
    }
    return header[1], set(node_labels.values()), edges


def _d2_topology(
    source: str,
) -> tuple[str, set[str], set[tuple[str, str, str]]]:
    lines = [line.strip() for line in source.splitlines() if line.strip()]
    direction_key, direction = lines[0].split(":", 1)
    assert direction_key.strip() == "direction"

    node_labels: dict[str, str] = {}
    raw_edges: list[tuple[str, str, str]] = []
    for line in lines[1:]:
        if edge := _D2_EDGE.fullmatch(line):
            raw_edges.append((edge.group(1), json.loads(edge.group(3)), edge.group(2)))
        elif node := _D2_NODE.fullmatch(line):
            node_labels[node.group(1)] = json.loads(node.group(2))
        else:
            raise AssertionError(f"Unrecognized D2 statement: {line}")

    edges = {
        (node_labels[source_id], label, node_labels[target_id])
        for source_id, label, target_id in raw_edges
    }
    return direction.strip(), set(node_labels.values()), edges


def test_notebook_graph_drops_invalid_browser_entries() -> None:
    widget = obs.Notebook(obs.ojs("answer = 42", key="answer"))
    widget.set_trait(
        "_graph",
        {
            "cells": [
                {
                    "id": 1,
                    "index": 0,
                    "key": "answer",
                    "mode": "ojs",
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
        obs.ojs("answer + 1", key="readout"),
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

    with pytest.raises(KeyError, match="Unknown Observable cell key"):
        widget.cell_by_key("answer")
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


def test_cell_lookup_separates_python_key_from_ojs_variable(
    browser_graph_sync: BrowserGraphSync,
    browser_graph_cell: BrowserGraphCellBuilder,
) -> None:
    widget = obs.Notebook(
        obs.ojs("alpha = 1", key="conflict"),
        obs.ojs("conflict = 2", key="other"),
    )
    browser_graph_sync(
        widget,
        cells=[
            browser_graph_cell("python-name", defines=["alpha"]),
            browser_graph_cell("ojs-variable", defines=["conflict"]),
        ],
    )

    assert widget.cell_by_key("conflict").defines == ("alpha",)
    assert widget.cell_for_variable("conflict").key == "other"
    assert widget.cell_for_variable("conflict").defines == ("conflict",)


def test_named_notebook_cells_expose_values(
    browser_value_sync: BrowserValueSync,
) -> None:
    widget = obs.Notebook(obs.ojs("viewof gain = Inputs.range([0, 11])", key="gain"))
    cell_widget = widget.cell_by_key("gain")

    browser_value_sync(cell_widget, {"gain": 7}, ["gain"])

    assert cell_widget.value("gain") == 7
    assert cell_widget.only_value() == 7
    assert cell_widget.values == {"gain": 7}
    assert cell_widget.has_rendered is True


def test_direct_cell_render_keeps_parent_notebook_unrendered(
    browser_graph_sync: BrowserGraphSync,
    browser_graph_cell: BrowserGraphCellBuilder,
    browser_value_sync: BrowserValueSync,
) -> None:
    widget = obs.Notebook(
        obs.ojs("answer = 42", key="answer"),
        obs.ojs("double = answer * 2", key="double"),
    )
    browser_graph_sync(
        widget,
        cells=[
            browser_graph_cell("answer", defines=["answer"], output="answer"),
            browser_graph_cell(
                "double",
                defines=["double"],
                references=["answer"],
                output="double",
            ),
        ],
        edges=[("answer", "double", "answer")],
    )
    browser_value_sync(widget.cell_by_key("double"), {"double": 84}, ["double"])

    assert widget.has_graph_snapshot is True
    assert widget.has_rendered is False
    assert widget.graph.cell_for_variable("double").key == "double"
    assert widget.cell_by_key("double").value("double") == 84
    with pytest.raises(obs.NotRenderedError):
        widget.runtime_values
    with pytest.raises(obs.NotRenderedError):
        widget.cell_values()


def test_cell_value_error_points_to_values_mapping(
    browser_value_sync: BrowserValueSync,
) -> None:
    cell_widget = obs.Notebook(obs.ojs("answer = 42", key="cell")).cell_by_key("cell")
    browser_value_sync(cell_widget, {"answer": 42, "double": 84})

    with pytest.raises(KeyError, match=r"cell\.value\(name\)"):
        cell_widget.only_value()


def test_browser_values_are_exposed_to_notebook_values(
    browser_value_sync: BrowserValueSync,
) -> None:
    widget = obs.Notebook(obs.ojs("viewof gain = Inputs.range([0, 11])", key="gain"))

    browser_value_sync(widget, {"gain": 8}, ["gain"])

    assert widget.has_rendered is True
    assert widget.runtime_values == {"gain": 8}
    assert widget.value("gain") == 8


def test_cell_handle_reads_parent_snapshot_created_before_it() -> None:
    widget = obs.Notebook(obs.ojs("answer = 42", key="answer"))
    widget.set_trait(
        "_cell_values",
        {
            "0": {
                "rendered": True,
                "names": ["answer"],
                "values": {"answer": 42},
            }
        },
    )

    cell = widget.cell_at(0)

    assert cell.has_rendered is True
    assert cell.values == {"answer": 42}


def test_closing_notebook_closes_live_cell_display_models() -> None:
    widget = obs.Notebook(obs.ojs("answer = 42", key="answer"))
    cell = widget.cell_at(0)
    cell._repr_mimebundle_()
    cell._repr_mimebundle_()
    views = tuple(widget._cell_views)

    widget.close()

    assert widget.comm is None
    assert len(views) == 2
    assert all(view.comm is None for view in views)


def test_notebook_cell_display_rejects_a_closed_parent() -> None:
    widget = obs.Notebook(obs.ojs("answer = 42", key="answer"))
    cell = widget.cell_at(0)
    widget.close()

    with pytest.raises(RuntimeError, match="parent Notebook is closed"):
        cell._repr_mimebundle_()


def _widget_model_id(bundle: tuple[dict[str, Any], dict[str, Any]] | None) -> str:
    assert bundle is not None
    data, _metadata = bundle
    widget_view = data["application/vnd.jupyter.widget-view+json"]
    assert isinstance(widget_view, dict)
    model_id = widget_view["model_id"]
    assert isinstance(model_id, str)
    return model_id


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
