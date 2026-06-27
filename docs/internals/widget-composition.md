---
title: Widget composition
description: Parent and child widget ownership in pyobservablejs.
---

# Widget composition

The parent `Notebook` widget owns rendering. Child `NotebookCell` widgets expose
Python handles for values, metadata, and direct cell display.

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

Display the parent `Notebook` for the full notebook.

```python
view = mo.ui.anywidget(notebook)
view
```

Display a child `NotebookCell` for one cell output.

```python
cell = notebook.cell_by_key("chart")
mo.ui.anywidget(cell)
```

The child model syncs `_notebook_widget` and `_notebook_index`. Direct display
uses those traits to resolve the parent model, build a projected Observable
runtime from the parent notebook, and render the selected cell. Dependency cells
are defined in that runtime so references work, but only the selected cell is
visible and synced to the child model.

## Failure mode

Frontends that cannot resolve child widget models can still receive the parent
trait state, but cell handles and composition-dependent rendering fail. Direct
cell display raises an error when `_notebook_widget` cannot be resolved. Use a
Jupyter or marimo frontend with anywidget support when reading values, graph
metadata, or standalone cell outputs from Python.
