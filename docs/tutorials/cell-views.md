---
title: Cell Values
description: Read Observable cell values through NotebookCell handles.
---

# Cell Values

Name a cell when Python needs to read its synchronized value or graph metadata.
Display the parent `Notebook` to render Observable outputs.

```{marimo-config}
:pyproject:

  requires-python = ">=3.10"
  dependencies = [
      "pyobservablejs @ https://files.peter.gy/pkg/py/pyobservablejs/pyobservablejs-0.0.0rc1-py3-none-any.whl#sha256=02b7ec0a297f81dd77f425a5e315eba537a71f93d9d58057ea0d004639cd44d8",
  ]
```

```python
import json

import marimo as mo
import pyobservablejs as obs

cell_notebook = obs.Notebook(
    obs.ojs(
        'viewof gain = Inputs.range([0, 12], '
        '{value: 5, step: 1, label: "gain"})',
        name="gain",
    ),
    obs.ojs("double = gain * 2", name="double"),
    obs.ojs(
        """
        md`The browser value is **${gain}**, so double is **${double}**.`
        """,
        name="readout",
    ),
)

cell_view = mo.ui.anywidget(cell_notebook)
cell_view
```

```{marimo} python
:include: false

import json

import marimo as mo
import pyobservablejs as obs
```

```{marimo} python
:include: false

cell_notebook = obs.Notebook(
    obs.ojs(
        'viewof gain = Inputs.range([0, 12], '
        '{value: 5, step: 1, label: "gain"})',
        name="gain",
    ),
    obs.ojs("double = gain * 2", name="double"),
    obs.ojs(
        """
        md`The browser value is **${gain}**, so double is **${double}**.`
        """,
        name="readout",
    ),
)
cell_view = mo.ui.anywidget(cell_notebook)
```

```{marimo} python
cell_view
```

Read synchronized values from a later Python cell:

```python
cell_view.value
values = cell_notebook.values
mo.md(
    "Browser-synchronized values: "
    f"`{json.dumps(values, sort_keys=True)}`"
)
```

```{marimo} python
cell_view.value
values = cell_notebook.values
mo.md(
    "Browser-synchronized values: "
    f"`{json.dumps(values, sort_keys=True)}`"
)
```

`notebook.cell("gain")` returns the `NotebookCell` handle for the named input
cell:

```python
gain = cell_notebook.cell("gain")

gain.value
cell_notebook.value("double")
```

The `NotebookCell` handle also exposes graph metadata after the browser renders:

```python
gain.values
gain.info
gain.defines
gain.references
```

`NotebookCell.values` contains JSON-compatible values synchronized through
anywidget traits. DOM nodes such as controls, SVG, canvas, and figures stay in
the browser output owned by the parent notebook.
