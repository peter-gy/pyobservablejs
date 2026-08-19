---
name: pyobservablejs
description: >-
  Build, render, inspect, and synchronize Observable JavaScript notebooks from
  Python with pyobservablejs. Use when an agent needs to author Notebook Kit
  cells, embed a notebook in anywidget hosts such as JupyterLab or marimo, send
  Python values into the browser graph, read structured browser results,
  compose keyed views, attach files, or import Notebook Kit and ObservableHQ
  sources.
---

# Build with pyobservablejs

Use the public `observablejs` API for notebook construction and state. Python
owns the `Notebook` controller and its values. Each `NotebookView` owns a
browser runtime that analyzes, evaluates, and renders the selected cells.

Start with a keyed notebook:

```python
import observablejs as obs

notebook = obs.Notebook(
    obs.js(
        """
        const threshold = view(Inputs.range(
          [0, 1],
          {value: 0.5, step: 0.1, label: "Threshold"}
        ));
        """,
        key="threshold_control",
    ),
    obs.js(
        "html`<strong>Threshold: ${threshold}</strong>`",
        key="summary",
    ),
)

view = notebook.view()
view
```

Keep `notebook` and `view` available while the output is mounted. Use a cell
`key` for every cell that later code needs to select, inspect, or read back.

## Choose the cell mode

- `obs.js(source)` runs standard Notebook Kit JavaScript. Top-level
  declarations participate in the reactive graph. Use `view(...)` for browser
  inputs and `display(...)` when a program cell should render a value.
- `obs.ojs(source)` runs Observable JavaScript. Use it for `viewof`
  declarations and existing Observable notebook source.
- `obs.md(source)` renders Markdown.
- `obs.html(source)` renders HTML.

Cells in both JavaScript modes share one dependency graph inside a view.
Notebook Kit schedules them from definitions and references, independent of
source order.

## Create the view the task needs

`notebook.view()` renders every cell. Pass public keys, keyed authored cells,
or canonical handles from `notebook.cell(key)` to focus the output:

```python
summary_view = notebook.view("summary")
```

A focused view evaluates the selected cell and its dependencies while hiding
dependency outputs. Create separate views for separate host locations. Views
from one notebook receive the same Python variables and serializable named
browser input values, while evaluation results and lifecycle remain per view.

Set `capture_state=False` when the host needs rendered output and Python will
not inspect browser results:

```python
preview = notebook.view(capture_state=False)
```

## Synchronize Python and browser values

Send a patch through the controller:

```python
notebook.update_variables({"threshold": 0.8})
```

Use `replace_variables(mapping)` when the mapping is the complete Python-owned
environment. Use `reset_variables(*names)` to release names back to Notebook
Kit evaluation.

In marimo, reference `view.value` before reading `view.state` so the cell reruns
when widget state changes. Read a result after the current browser revision
settles:

```python
view.value
state = view.state

if (
    not state.pending
    and state.input_revision is not None
    and state.settled_revision == state.input_revision
):
    summary = state.result("summary")
    print(summary.status, summary.values, summary.errors)
```

Wait on these observable revision fields or a traitlets observer. Avoid elapsed
time as a readiness signal.

## Use sources, files, and advanced state deliberately

Read [references/workflows.md](references/workflows.md) when the task involves:

- local files or `FileAttachment`
- Notebook Kit HTML or ObservableHQ imports
- several synchronized views
- browser errors or dependency graphs
- export and close behavior

Imported HTML, ObservableHQ notebooks, and remote JavaScript execute with the
host page's browser privileges. Treat those sources as executable code.

The published documentation exposes a compact map at
<https://peter-gy.github.io/pyobservablejs/llms.txt> and the complete guide at
<https://peter-gy.github.io/pyobservablejs/llms-full.txt>.

## Finish through the consumer boundary

Render the result in the target notebook host. Exercise affected inputs, read
settled state when the task depends on it, and inspect browser errors. Close a
view with `view.close()` when its runtime is finished. Close the controller with
`notebook.close()` when every view from that notebook is finished.
