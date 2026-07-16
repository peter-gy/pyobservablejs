---
title: Views and composition
description: Select notebook cells, mount each view, and synchronize variables and inputs.
---

# Views and composition

Call `notebook.view()` to choose which cells render together. It returns a
`NotebookView`, which Jupyter displays directly and marimo mounts through
`mo.ui.anywidget`. Browser evaluation begins when the view mounts.

The browser loads Plot for this example. See [Notebook
runtime](notebook-runtime.md#builtins) for network and content security policy
requirements.

```python
import observablejs as obs

notebook = obs.Notebook(
    obs.js(
        "const numbers = [2, 4, 8, 16];",
        key="numbers",
        display=False,
    ),
    obs.js(
        """
        Plot.barY(numbers, {
          x: (_, index) => index + 1,
          y: (value) => value * scale
        }).plot({height: 220, x: {label: "Position"}, y: {grid: true}})
        """,
        key="chart",
    ),
    obs.js(
        """
        html`<p>
          ${numbers.length} values,
          ending at <strong>${numbers.at(-1) * scale}</strong>.
        </p>`
        """,
        key="summary",
    ),
    variables={"scale": 1},
)

full_view = notebook.view()
```

`Notebook` owns the cell definitions, variables, attachments, theme, and shared
input values. `NotebookView` owns one browser runtime, its rendered output, and
its synchronized readback.

## Choose the cells in a view

Each call creates a new `NotebookView`.

| Shape     | Call                                        | Cells rendered together                                        |
| --------- | ------------------------------------------- | -------------------------------------------------------------- |
| Full      | `notebook.view()`                           | Every notebook cell, subject to each cell's `display` setting. |
| Focused   | `notebook.cell_by_key("chart").view()`      | One selected cell. Its dependencies evaluate as hidden cells.  |
| Composite | `notebook.view(cells=["chart", "summary"])` | Several selected cells and their hidden dependency closure.    |

A composite view of `chart` and `summary` evaluates `numbers` once, then renders
the two selected cells in notebook order. The focused chart view also evaluates
the hidden `numbers` cell because the chart depends on it.

`cells` also accepts zero-based indices and `NotebookCell` handles. See
[`Notebook.view`](../reference/notebook.md#create-views) for selection
validation and error behavior.

## How a view runs

Mounting a `NotebookView` follows one lifecycle:

1. The view resolves its notebook session and selected cells.
2. The view includes every dependency required by those cells.
3. One browser runtime evaluates the resulting graph.
4. Selected cells render in notebook order. Dependency cells stay hidden.
5. The view synchronizes its graph and selected-cell values back to Python.

Each mounted `NotebookView` owns its runtime and readback snapshot. Use a
composite view when several outputs should share one runtime. Use separate
views when outputs belong in separate frontend locations or need separate
readback.

## What views share

Views from the same notebook share the notebook-owned values shown below. Their
runtime and rendered output remain independent.

| Shared through `Notebook`                              | Owned by each `NotebookView`       |
| ------------------------------------------------------ | ---------------------------------- |
| Cell definitions and attachments                       | Browser runtime and DOM output     |
| Theme and Python variables                             | Selected cells                     |
| Supported values from compatible named `viewof` inputs | Graph and synchronized cell values |
| Notebook close lifecycle                               | View close lifecycle               |

Changing a Python variable updates every active view from that notebook.

```python
notebook.update_variables(scale=2)
```

When a named `viewof` input changes, the notebook records its value if it has a
[supported shared
shape](../reference/variables.md#python-values-and-viewof-inputs). Existing
sibling views and views mounted later attempt to write that value to a matching
input. A successful round trip dispatches `input` and `change` events and
updates dependent cell values. Use the same input type for a shared name across
views because a target can coerce an incompatible value before the round-trip
check suppresses those events.

## Python `.view()` and JavaScript `view(...)`

The Python methods create renderable notebook views. JavaScript `view(input)`
defines a reactive input.

| Call                          | Result                                                                  |
| ----------------------------- | ----------------------------------------------------------------------- |
| `notebook.view(...)`          | Creates a Python `NotebookView` for a full or composite cell selection. |
| `notebook_cell.view()`        | Creates a Python `NotebookView` focused on one cell.                    |
| `view(input)` inside `obs.js` | Displays a browser input and exposes its current value to the graph.    |

This JavaScript cell creates a range input and defines the reactive variable
`threshold`:

```python
obs.js(
    """
    const threshold = view(Inputs.range(
      [0, 1],
      {label: "Threshold", step: 0.05, value: 0.5}
    ));
    """
)
```

Moving the input changes `threshold`. Notebook Kit reruns cells that reference
that name. Python `notebook.view()` decides which of those cells evaluate and
render together.

## Mount views in Jupyter and marimo

Jupyter displays a `NotebookView` when it is the final expression in a cell.

```python
full_view
```

Marimo mounts each view through `mo.ui.anywidget`.

```python
import marimo as mo

full_widget = mo.ui.anywidget(full_view)
full_widget
```

Keep the wrapper mounted while Python updates variables. Create a distinct
`NotebookView` for each simultaneously mounted output.

```python
chart_view = notebook.cell_by_key("chart").view()
summary_view = notebook.cell_by_key("summary").view()

mo.hstack([
    mo.ui.anywidget(chart_view),
    mo.ui.anywidget(summary_view),
])
```

## Read values from the rendering view

Readback belongs to the view whose runtime produced it. `graph` includes the
selected cells and their dependency closure. `runtime_values` and
`cell_values()` expose values from the selected cells.

```python
if chart_view.has_rendered:
    values = chart_view.runtime_values
    graph = chart_view.graph
```

`NotebookView.close()` closes one view. `Notebook.close()` closes the session
and every view created from it.

Continue with [values back to Python](cell-values.md) for readback and
[Python variables](python-variables.md) for live session updates.
