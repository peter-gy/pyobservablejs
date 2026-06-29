from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

import observablejs as obs
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
    with pytest.raises(TypeError, match="obs.ojs"):
        obs.Notebook(bad_cells)


def test_notebook_cell_accessors_return_child_widget_instances() -> None:
    widget = obs.Notebook(
        obs.md("# Title", key="title"),
        obs.ojs("answer = 42", key="answer"),
        title="Composed",
    )

    assert len(widget.cells) == 2
    assert [widget.cell_at(index).key for index in range(2)] == ["title", "answer"]
    assert [cell.key for cell in widget.cells] == ["title", "answer"]
    assert [cell.name for cell in widget.cells] == ["", ""]
    assert widget.cell_by_key("answer").key == "answer"
    assert widget.cell_at(1) is widget.cells[1]
    assert widget.cell_by_key("answer") is widget.cells[1]
    assert widget.get_state(["_cell_keys"])["_cell_keys"] == ["title", "answer"]
    child_state = widget.cell_at(1).get_state(["_notebook_widget", "_notebook_index"])
    assert child_state["_notebook_widget"] == f"anywidget:{widget.model_id}"
    assert child_state["_notebook_index"] == 1


def test_notebook_cell_parent_reference_accepts_browser_wire_state() -> None:
    widget = obs.Notebook(obs.ojs("answer = 42", key="answer"))
    cell = widget.cell_at(0)
    ref = f"anywidget:{widget.model_id}"

    cell.set_state({"_notebook_widget": ref})

    assert cell.get_state(["_notebook_widget"])["_notebook_widget"] == ref


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

    assert widget.graph.to_mermaid() == (
        "flowchart LR\n"
        '  cell_0["Cell 0: alpha, defines: a"]\n'
        '  cell_1["Cell 1: beta, defines: b"]\n'
        '  external_0["external: rows"]\n'
        "  cell_0 -->|a| cell_1\n"
        "  external_0 -->|rows| cell_1\n"
    )


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

    assert widget.graph.to_d2() == (
        "direction: right\n"
        'cell_0: "Cell 0: alpha, defines: a"\n'
        'cell_1: "Cell 1: beta, defines: b"\n'
        'external_0: "external: rows"\n'
        'cell_0 -> cell_1: "a"\n'
        'external_0 -> cell_1: "rows"\n'
    )


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

    assert "#quot;" in widget.graph.to_mermaid()
    assert "#124;" in widget.graph.to_mermaid()
    assert json.loads(widget.graph.to_d2().splitlines()[1].split(": ", 1)[1]) == (
        'Cell 0: quote " cell, defines: answer "1"'
    )


def test_notebook_graph_diagram_exports_are_valid_when_tools_are_available(
    browser_graph_sync: BrowserGraphSync,
    browser_graph_cell: BrowserGraphCellBuilder,
    tmp_path: Path,
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
    ran_validator = False
    d2 = shutil.which("d2")
    if d2 is not None:
        d2_path = tmp_path / "graph.d2"
        d2_path.write_text(widget.graph.to_d2())
        subprocess.run([d2, "validate", str(d2_path)], check=True)
        ran_validator = True
    chrome_path = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    mmdc = shutil.which("mmdc")
    if mmdc is not None and os.path.exists(chrome_path):
        mermaid_path = tmp_path / "graph.mmd"
        svg_path = tmp_path / "graph.svg"
        puppeteer_path = tmp_path / "puppeteer.json"
        mermaid_path.write_text(widget.graph.to_mermaid())
        puppeteer_path.write_text(
            json.dumps({"executablePath": chrome_path, "args": ["--no-sandbox"]})
        )
        subprocess.run(
            [
                mmdc,
                "-i",
                str(mermaid_path),
                "-o",
                str(svg_path),
                "-q",
                "-p",
                str(puppeteer_path),
            ],
            check=True,
        )
        assert svg_path.exists()
        ran_validator = True
    if not ran_validator:
        pytest.skip("D2 and Mermaid validators are unavailable")


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

    browser_value_sync(cell_widget, {"gain": 7}, ["gain", "doubled"])

    assert cell_widget.value("gain") == 7
    assert cell_widget.only_value() == 7
    assert cell_widget.values == {"gain": 7}
    assert cell_widget.has_rendered is True
    assert widget.has_rendered is False
    assert widget.has_graph_snapshot is True
    with pytest.raises(obs.NotRenderedError):
        widget.runtime_values
    with pytest.raises(obs.NotRenderedError):
        widget.cell_values()


def test_direct_cell_render_does_not_mark_parent_notebook_rendered(
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
