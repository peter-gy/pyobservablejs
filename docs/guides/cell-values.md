---
title: Values back to Python
description: Read browser-synchronized values and graph metadata from Python.
---

# Values back to Python

`NotebookCell` values and graph metadata synchronize after the browser renders
the widget. Try moving `gain`. The readout updates in the browser. A later
Python cell can then read the synchronized `doubled` value.

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
    obs.js(
        'const gain = view(Inputs.range([0, 12], {value: 5, step: 1, label: "Gain"}));',
        key="gain_control",
    ),
    obs.js("const doubled = gain * 2;", key="doubled", display=False),
    obs.js(
        'html`<p>Gain is <strong>${gain}</strong>. Doubled is <strong>${doubled}</strong>.</p>`',
        key="readout",
    ),
)

widget = mo.ui.anywidget(notebook)
widget
```

After render, read values through the notebook or the cell that owns them.

```python
gain_cell = notebook.cell_by_key("gain_control")
gain_value = gain_cell.value("gain")
doubled_value = notebook.value("doubled")
runtime_values = notebook.runtime_values
cell_values = notebook.cell_values()
```

## Inspect the graph

The browser also reports cell definitions and references.

```python
if notebook.has_graph_snapshot:
    graph = notebook.graph
    doubled_cell = notebook.cell_for_variable("doubled")
    defined_names = doubled_cell.defines
    referenced_names = doubled_cell.references
```

`notebook.graph` raises `NotRenderedError` before graph metadata arrives.
`cell_for_variable(name)` raises `KeyError` when the graph has no unique owner
for `name`.

Displaying one `NotebookCell` synchronizes that cell and the parent graph.
Display the parent `Notebook` when Python needs values from the full document.

See [Values and graph](../reference/values-and-graph.md) for the complete
lifecycle and lookup contracts.
