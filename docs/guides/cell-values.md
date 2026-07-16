---
title: Values back to Python
description: Read browser-synchronized values and graph metadata from a rendered view.
---

# Values back to Python

`NotebookView` synchronizes values and graph metadata after its browser runtime
renders. Try moving `gain`. The readout updates in the browser, and a later
Python cell can read `doubled` from the same view.

The browser loads `Inputs` for this example. See [Notebook
runtime](notebook-runtime.md#builtins) for network and content security policy
requirements.

```{marimo-config}
:pyproject:

  requires-python = ">=3.11"
  dependencies = [
      "pyobservablejs",
  ]
```

```{marimo} python
:echo: true

import marimo as mo
import observablejs as obs

notebook = obs.Notebook(
    obs.ojs(
        'viewof gain = Inputs.range([0, 12], {value: 5, step: 1, label: "Gain"})',
        key="gain_control",
    ),
    obs.js("const doubled = gain * 2;", key="doubled", display=False),
    obs.js(
        'html`<p>Gain is <strong>${gain}</strong>. Doubled is <strong>${doubled}</strong>.</p>`',
        key="readout",
    ),
)

full_view = notebook.view()
widget = mo.ui.anywidget(full_view)
widget
```

Read values after `full_view.has_rendered` becomes true.

```python
if full_view.has_rendered:
    gain_value = full_view.value("gain")
    doubled_value = full_view.value("doubled")
    runtime_values = full_view.runtime_values
    cell_values = full_view.cell_values()
```

## Inspect one cell

`NotebookCell` selects a cell from the definition. Call `view()` to create its
renderable view and read values from that view after render.

```python
gain_view = notebook.cell_by_key("gain_control").view()
gain_widget = mo.ui.anywidget(gain_view)
gain_widget
```

```python
if gain_view.has_rendered:
    gain_value = gain_view.value("gain")
```

When the user changes `viewof gain`, `full_view` and `gain_view`
share the interacted numeric value through their notebook session. They keep
separate runtimes and readback snapshots. The [variables
reference](../reference/variables.md#python-values-and-viewof-inputs) lists the
value shapes that can be shared. Wrap each view independently in marimo and
keep both wrappers mounted when both outputs belong on the page.

## Keep selected cells in one runtime

A composite view evaluates selected cells and their dependencies in one
runtime.

```python
summary_view = notebook.view(cells=[0, 1])
summary_widget = mo.ui.anywidget(summary_view)
summary_widget
```

Read the composite graph and values from `summary_view`.

```python
if summary_view.has_graph_snapshot:
    graph = summary_view.graph
    doubled_cell = graph.cell_for_variable("doubled")
    defined_names = doubled_cell.defines
    referenced_names = doubled_cell.references
```

`summary_view.graph` raises `NotRenderedError` before graph metadata arrives.
`graph.cell_for_variable(name)` raises `KeyError` when the graph has no unique
owner for `name`.

See [Values and graph](../reference/values-and-graph.md) for the complete
lifecycle and lookup contracts.
