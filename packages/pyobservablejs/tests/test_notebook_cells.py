from __future__ import annotations

import json
import re
from typing import Any

import observablejs as obs
import pytest
import traitlets
from IPython.core.formatters import DisplayFormatter
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


def test_notebook_view_calls_create_distinct_stable_display_models() -> None:
    notebook = obs.Notebook(
        obs.md("# Title", key="title"),
        obs.ojs("answer = 42", key="answer"),
    )
    first = notebook.view()
    second = notebook.view()

    formatter = DisplayFormatter()
    first_id = _display_model_id(formatter, first)

    assert first is not second
    assert first_id != _display_model_id(formatter, second)
    assert _display_model_id(formatter, first) == first_id


def test_notebook_view_serializes_session_and_cell_selection() -> None:
    notebook = obs.Notebook(
        obs.md("# Title", key="title"),
        obs.ojs("answer = 42", key="answer"),
    )
    full = notebook.view()
    selected = notebook.view([1, "title"])
    state = selected.get_state(["role", "_notebook", "_cell_indexes"])

    assert notebook.role == "session"
    assert full.role == "view"
    assert full.cell_indexes is None
    assert selected.notebook is notebook
    assert selected.cell_indexes == (0, 1)
    assert state == {
        "role": "view",
        "_notebook": f"anywidget:{notebook.model_id}",
        "_cell_indexes": [0, 1],
    }


def test_notebook_cell_view_selects_its_index() -> None:
    notebook = obs.Notebook(
        obs.ojs("answer = 42", key="answer"),
        obs.ojs("double = answer * 2", key="double"),
    )

    view = notebook.cell_by_key("double").view()

    assert view.notebook is notebook
    assert view.cell_indexes == (1,)


def test_selected_view_readback_uses_notebook_order(
    browser_value_sync: BrowserValueSync,
) -> None:
    notebook = obs.Notebook(
        obs.ojs("a = 1", key="a"),
        obs.ojs("b = 2", key="b"),
        obs.ojs("c = 3", key="c"),
    )
    view = notebook.view([2, 0])
    browser_value_sync(view, {"c": 3}, index=2)
    browser_value_sync(view, {"a": 1}, index=0)

    assert view.cell_indexes == (0, 2)
    assert view.get_state(["_cell_indexes"])["_cell_indexes"] == [0, 2]
    assert view.cell_values() == (
        obs.CellValues(index=0, key="a", values={"a": 1}),
        obs.CellValues(index=2, key="c", values={"c": 3}),
    )


def test_notebook_view_validates_selections() -> None:
    notebook = obs.Notebook(obs.ojs("answer = 42", key="answer"))
    other = obs.Notebook(obs.ojs("other = 1", key="other"))

    assert notebook.view([-1]).cell_indexes == (0,)
    with pytest.raises(ValueError, match="at least one"):
        notebook.view([])
    with pytest.raises(ValueError, match="each notebook cell once"):
        notebook.view([0, "answer"])
    with pytest.raises(ValueError, match="another Notebook"):
        notebook.view([other.cell_at(0)])
    scalar_selection: Any = "answer"
    with pytest.raises(TypeError, match="sequence"):
        notebook.view(scalar_selection)
    boolean_selection: Any = [True]
    with pytest.raises(TypeError, match="must contain"):
        notebook.view(boolean_selection)


@pytest.mark.parametrize(
    "cells",
    [{0: "answer"}, {0}, bytearray([0])],
    ids=["mapping", "set", "bytearray"],
)
def test_notebook_view_requires_a_sequence_container(cells: Any) -> None:
    notebook = obs.Notebook(obs.ojs("answer = 42", key="answer"))

    with pytest.raises(TypeError, match="must be a sequence"):
        notebook.view(cells)


@pytest.mark.parametrize(
    "cell_indexes",
    [{0: "answer"}, {0}, bytearray([0]), "0", b"0"],
    ids=["mapping", "set", "bytearray", "string", "bytes"],
)
def test_notebook_view_constructor_requires_a_sequence_container(
    cell_indexes: Any,
) -> None:
    notebook = obs.Notebook(obs.ojs("answer = 42", key="answer"))

    with pytest.raises(TypeError, match="cell_indexes must be a sequence"):
        obs.NotebookView(notebook, cell_indexes=cell_indexes)


def test_notebook_view_constructor_accepts_sequence_indexes() -> None:
    notebook = obs.Notebook(
        obs.ojs("a = 1", key="a"),
        obs.ojs("b = 2", key="b"),
    )

    view = obs.NotebookView(notebook, cell_indexes=(1, 0))

    assert view.cell_indexes == (0, 1)


def test_notebook_view_session_reference_rejects_browser_wire_state() -> None:
    notebook = obs.Notebook(obs.ojs("answer = 42", key="answer"))
    view = notebook.view()
    ref = f"anywidget:{notebook.model_id}"

    with pytest.raises(traitlets.TraitError, match="expected a Notebook"):
        view.set_state({"_notebook": ref})

    assert view.notebook is notebook


def test_notebook_view_rejects_an_empty_wire_selection() -> None:
    view = obs.Notebook(obs.ojs("answer = 42", key="answer")).view()

    with pytest.raises(traitlets.TraitError, match="non-empty"):
        view.set_state({"_cell_indexes": []})


def test_notebook_graph_exposes_symbolic_cell_metadata(
    browser_graph_sync: BrowserGraphSync,
    browser_graph_cell: BrowserGraphCellBuilder,
) -> None:
    notebook = obs.Notebook(
        obs.ojs("a = 1", key="a"),
        obs.ojs("b = a + rows.length", key="b"),
        variables={"rows": [{"x": 1}]},
    )
    view = notebook.view()
    browser_graph_sync(
        view,
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

    graph = view.graph

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
    assert notebook.cell_by_key("b").key == "b"


def test_view_graph_waits_for_a_complete_snapshot() -> None:
    view = obs.Notebook().view()

    assert view.has_graph_snapshot is False
    with pytest.raises(obs.NotRenderedError, match="after the view renders"):
        _ = view.graph

    view.set_trait(
        "_readback",
        {
            "revision": 1,
            "rendered": False,
            "graph": {"cells": [], "edges": []},
            "cells": {},
        },
    )

    assert view.has_graph_snapshot
    assert view.graph == obs.NotebookGraph(cells=(), edges=())


def test_view_readback_rejects_an_out_of_order_browser_snapshot() -> None:
    view = obs.Notebook(obs.ojs("answer = 42", key="answer")).view()
    view.set_trait(
        "_readback",
        {
            "revision": 2,
            "rendered": True,
            "graph": {"cells": [], "edges": []},
            "cells": {
                "0": {
                    "rendered": True,
                    "names": ["answer"],
                    "values": {"answer": 42},
                }
            },
        },
    )

    view.set_trait(
        "_readback",
        {
            "revision": 1,
            "rendered": False,
            "graph": {},
            "cells": {},
        },
    )

    assert view.has_rendered is True
    assert view.graph == obs.NotebookGraph(cells=(), edges=())
    assert view.runtime_values == {"answer": 42}
    assert view.cell_values() == (
        obs.CellValues(index=0, key="answer", values={"answer": 42}),
    )


def test_notebook_graph_exports_mermaid_dependency_diagram(
    browser_graph_sync: BrowserGraphSync,
    browser_graph_cell: BrowserGraphCellBuilder,
) -> None:
    notebook = obs.Notebook(
        obs.ojs("a = 1", key="alpha"),
        obs.ojs("b = a + rows.length", key="beta"),
        variables={"rows": [{"x": 1}]},
    )
    view = notebook.view()
    browser_graph_sync(
        view,
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

    direction, nodes, edges = _mermaid_topology(view.graph.to_mermaid())

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
    notebook = obs.Notebook(
        obs.ojs("a = 1", key="alpha"),
        obs.ojs("b = a + rows.length", key="beta"),
        variables={"rows": [{"x": 1}]},
    )
    view = notebook.view()
    browser_graph_sync(
        view,
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

    direction, nodes, edges = _d2_topology(view.graph.to_d2())

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
    notebook = obs.Notebook(
        obs.ojs("answer = 42", key='quote " cell'),
        obs.ojs("answer + row_count", key="readout"),
    )
    view = notebook.view()
    browser_graph_sync(
        view,
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
        view.graph.to_mermaid()
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

    d2_direction, d2_nodes, d2_edges = _d2_topology(view.graph.to_d2())
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
    view = obs.Notebook(obs.ojs("answer = 42", key="answer")).view()
    view.set_trait(
        "_readback",
        {
            "revision": 1,
            "rendered": False,
            "graph": {
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
            "cells": {},
        },
    )

    graph = view.graph

    assert graph is not None
    assert [cell.defines for cell in graph.cells] == [("answer",)]
    assert graph.edges == ()


def test_view_graph_resolves_a_unique_variable(
    browser_graph_sync: BrowserGraphSync,
    browser_graph_cell: BrowserGraphCellBuilder,
) -> None:
    notebook = obs.Notebook(
        obs.ojs("answer = 42"),
        obs.ojs("answer + 1", key="readout"),
    )
    view = notebook.view()
    browser_graph_sync(
        view,
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
        notebook.cell_by_key("answer")
    assert view.graph.cell_for_variable("answer").index == 0
    assert view.graph.cell_for_variable("answer").defines == ("answer",)


def test_view_graph_rejects_an_ambiguous_variable(
    browser_graph_sync: BrowserGraphSync,
    browser_graph_cell: BrowserGraphCellBuilder,
) -> None:
    notebook = obs.Notebook(
        obs.ojs("answer = 42"),
        obs.ojs("answer = 43"),
    )
    view = notebook.view()
    browser_graph_sync(
        view,
        cells=[
            browser_graph_cell("first-answer", defines=["answer"]),
            browser_graph_cell("second-answer", defines=["answer"]),
        ],
    )

    with pytest.raises(KeyError, match="Ambiguous Observable variable"):
        view.graph.cell_for_variable("answer")


def test_view_graph_keeps_python_keys_separate_from_ojs_variables(
    browser_graph_sync: BrowserGraphSync,
    browser_graph_cell: BrowserGraphCellBuilder,
) -> None:
    notebook = obs.Notebook(
        obs.ojs("alpha = 1", key="conflict"),
        obs.ojs("conflict = 2", key="other"),
    )
    view = notebook.view()
    browser_graph_sync(
        view,
        cells=[
            browser_graph_cell("python-name", defines=["alpha"]),
            browser_graph_cell("ojs-variable", defines=["conflict"]),
        ],
    )

    assert notebook.cell_by_key("conflict").key == "conflict"
    assert view.graph.cell_for_variable("conflict").key == "ojs-variable"
    assert view.graph.cell_for_variable("conflict").defines == ("conflict",)


def test_cell_view_exposes_its_synchronized_values(
    browser_value_sync: BrowserValueSync,
) -> None:
    notebook = obs.Notebook(obs.ojs("viewof gain = Inputs.range([0, 11])", key="gain"))
    view = notebook.cell_by_key("gain").view()

    browser_value_sync(view, {"gain": 7}, ["gain"])

    assert view.has_rendered is True
    assert view.runtime_values == {"gain": 7}
    assert view.value("gain") == 7
    assert view.cell_values() == (
        obs.CellValues(index=0, key="gain", values={"gain": 7}),
    )


def test_selected_view_owns_readback_independently_from_another_view(
    browser_graph_sync: BrowserGraphSync,
    browser_graph_cell: BrowserGraphCellBuilder,
    browser_value_sync: BrowserValueSync,
) -> None:
    notebook = obs.Notebook(
        obs.ojs("answer = 42", key="answer"),
        obs.ojs("double = answer * 2", key="double"),
    )
    full = notebook.view()
    selected = notebook.cell_by_key("double").view()
    browser_graph_sync(
        selected,
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
    browser_value_sync(selected, {"double": 84}, ["double"], index=1)

    assert selected.has_graph_snapshot is True
    assert selected.graph.cell_for_variable("double").key == "double"
    assert selected.value("double") == 84
    assert selected.cell_values() == (
        obs.CellValues(index=1, key="double", values={"double": 84}),
    )
    assert full.has_rendered is False
    with pytest.raises(obs.NotRenderedError):
        full.runtime_values


def test_closing_notebook_closes_live_views() -> None:
    notebook = obs.Notebook(obs.ojs("answer = 42", key="answer"))
    first = notebook.view()
    second = notebook.cell_at(0).view()

    notebook.close()
    notebook.close()

    with pytest.raises(RuntimeError, match="closed NotebookView"):
        first.update_variables(answer=43)
    with pytest.raises(RuntimeError, match="closed NotebookView"):
        second.update_variables(answer=43)


def test_closed_notebook_keeps_cell_handles_readable_and_rejects_views() -> None:
    notebook = obs.Notebook(obs.ojs("answer = 42", key="answer"))
    cell = notebook.cell_at(0)
    notebook.close()

    assert cell.key == "answer"
    assert cell.name == ""
    with pytest.raises(RuntimeError, match="closed Notebook"):
        notebook.view()
    with pytest.raises(RuntimeError, match="closed Notebook"):
        cell.view()


def _display_model_id(
    formatter: DisplayFormatter,
    view: obs.NotebookView,
) -> str:
    data, _metadata = formatter.format(view)
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
