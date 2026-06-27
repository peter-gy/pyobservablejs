---
title: Widget composition
description: Parent and child widget ownership in pyobservablejs.
---

# Widget composition

The parent `Notebook` widget owns rendering. Child `NotebookCell` widgets expose
Python handles for values, metadata, and direct cell display.

```text
Notebook
  _cell_keys[0] -> Python helper key
  _cell_widgets[0] -> NotebookCell
  _cell_keys[1] -> Python helper key
  _cell_widgets[1] -> NotebookCell
  _cell_keys[2] -> Python helper key
  _cell_widgets[2] -> NotebookCell
```

The frontend resolves child models through the host widget manager before it
renders cells. Each child view is attached to the corresponding rendered cell.
The parent render owns cleanup for both runtime state and child views.

`NotebookCompositionState` reads `_cell_keys` and `_cell_widgets` from the
parent model as one transport concept. `CellCompositionState` reads
`_notebook_widget` and `_notebook_index` from a child model. Runtime rendering
uses those state objects instead of reading raw trait names throughout the
render path.

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

The parent model syncs `_cell_keys` so graph identity does not depend on child
model resolution order. The child model syncs `_notebook_widget` and
`_notebook_index`. Direct display uses those traits to resolve the parent model,
build a projected Observable runtime from the parent notebook, and render the
selected cell. Dependency cells are defined in that runtime so references work,
but only the selected cell is visible and synced to the child model.
Cells outside the selected cell's dependency closure are not defined for direct
display, so unrelated outputs do not run. A direct cell display marks the child
cell as rendered and can sync graph metadata to the parent. It does not mark the
parent notebook as fully rendered.

Both parent and direct display open a `NotebookRuntimeSession`. The session owns
the shell, scoped theme styles, attachment registry, Observable runtime,
variable sync, and abort cleanup. Cell rendering then consumes explicit
`CellRenderTarget` records. A parent target has one visible child model and a
direct target has one visible cell plus hidden dependency cells.

## Failure mode

Frontends that cannot resolve child widget models can still receive the parent
trait state, but cell handles and composition-dependent rendering fail. Direct
cell display raises an error when `_notebook_widget` cannot be resolved. Use a
Jupyter or marimo frontend with anywidget support when reading values, graph
metadata, or standalone cell outputs from Python.
