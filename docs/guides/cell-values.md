---
title: Cell values
description: Read browser-synchronized values and graph metadata from Python.
---

# Cell values

`NotebookCell` objects expose values and graph metadata synchronized from the
browser. Display the parent `Notebook` for full notebook values, or display a
single `NotebookCell` for that cell output.

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
        'viewof gain = Inputs.range([0, 12], {value: 5, step: 1, label: "gain"})',
        key="gain_control",
    ),
    obs.ojs("double = gain * 2", key="double_cell"),
    obs.ojs('md`gain is **${gain}** and double is **${double}**`', key="readout"),
)

view = mo.ui.anywidget(notebook)
view
```

Move `gain` from 5 to 8. The readout changes to `gain is 8 and double is 16`.
After the full notebook renders, `notebook.value("double")` returns the
synchronized browser value.

After the widget has rendered, the Python object can read synchronized values.

```python
gain_cell = notebook.cell_by_key("gain_control")
gain_value = gain_cell.value("gain")
double_value = notebook.value("double")
runtime_values = notebook.runtime_values
cell_values = notebook.cell_values()
```

The graph is also browser-produced. `notebook.graph` raises `NotRenderedError`
before graph metadata syncs.

```python
if notebook.has_graph_snapshot:
    graph = notebook.graph
    double_cell = notebook.cell_for_variable("double")
    defined_names = double_cell.defines
    referenced_names = double_cell.references
```

## Reading rules

`notebook.cell_at(index)` returns a cell by order. `notebook.cell_by_key(key)`
returns a cell by the Python helper `key`.

`notebook.cell_for_variable(name)` uses graph metadata to find the cell that
defines an Observable variable. It raises `NotRenderedError` before graph sync
and `KeyError` when no cell defines the variable or when more than one cell
defines it.

`NotebookCell.value(name)` reads a named synchronized value from one cell.
`NotebookCell.only_value()` is available when the cell exposes exactly one
value.

`notebook.runtime_values` contains notebook-level values synchronized by a full
notebook render. `notebook.cell_values()` returns values grouped by cell helper
name after the full notebook renders. Displaying one `NotebookCell` can sync that
cell's `values` and the parent graph without making full notebook values
available.
