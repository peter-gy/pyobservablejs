---
title: Widget composition
description: Parent and child widget ownership in pyobservablejs.
---

# Widget composition

The parent `Notebook` widget owns rendering. Child `NotebookCell` widgets expose
Python handles for values and metadata.

```text
Notebook
  _cell_widgets[0] -> NotebookCell
  _cell_widgets[1] -> NotebookCell
  _cell_widgets[2] -> NotebookCell
```

The frontend resolves child models through the host widget manager before it
renders cells. Each child view is attached to the corresponding rendered cell.
The parent render owns cleanup for both runtime state and child views.

## Display contract

Display the parent `Notebook`. A child `NotebookCell` does not create its own
Observable runtime, so direct display cannot render the cell independently.

```python
view = mo.ui.anywidget(notebook)
view
```

Read children from the parent object.

```python
cell = notebook.cell_by_key("chart")
cell.values
cell.info
```

## Failure mode

Frontends that cannot resolve child widget models can still receive the parent
trait state, but cell handles and composition-dependent rendering fail. Use a
Jupyter or marimo frontend with anywidget support when reading values or graph
metadata from Python.
