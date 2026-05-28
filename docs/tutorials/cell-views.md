---
title: Cell Views
description: Display one Observable cell as a child widget.
---

# Cell Views

Every `Notebook` owns a `NotebookCell` widget for each Observable cell. Display
the parent notebook first so the browser creates the runtime context, then
display a named child cell where you want a separate output.

```python
import marimo as mo
import pyobservablejs as obs

notebook = obs.Notebook(
    obs.ojs('viewof gain = Inputs.range([0, 11], {value: 5})', name="gain"),
    obs.ojs("double = gain * 2", name="double"),
)

mo.ui.anywidget(notebook)
```

Display one cell:

```python
mo.ui.anywidget(notebook.cell("gain"))
```

Read synchronized values from a later Python cell:

```python
notebook.value("gain")
notebook.value("double")
```

The child output has its own browser root. DOM values such as controls, SVG, and
canvas nodes stay in the browser. JSON-compatible values cross back through
trait state and appear in `NotebookCell.values` and `Notebook.values`.
