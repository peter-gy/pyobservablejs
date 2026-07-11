---
title: Notebook frontends
description: Render pyobservablejs views in Jupyter and marimo.
---

# Notebook frontends

`Notebook` stores the notebook definition and shared session state. Create a
`NotebookView` for the cells you want to render.

```python
import observablejs as obs

notebook = obs.Notebook(
    obs.js("const answer = 42;", key="answer"),
    obs.js('html`<p>Answer is ${answer}.</p>`', key="readout"),
)

full_view = notebook.view()
data_view = notebook.cell_at(0).view()
summary_view = notebook.view(cells=[0, 1])
```

`notebook.view()` selects every cell. `NotebookCell.view()` selects one cell
and its dependencies. Pass `cells` to create one composite view from a subset.

| Frontend   | Install                                 | Start                  | Render                        |
| ---------- | --------------------------------------- | ---------------------- | ----------------------------- |
| JupyterLab | `pip install pyobservablejs jupyterlab` | `jupyter lab`          | Return a `NotebookView`       |
| marimo     | `pip install pyobservablejs marimo`     | `marimo edit first.py` | Wrap each view with anywidget |

## Jupyter

Return a view as the last expression in a cell.

```python
import observablejs as obs

notebook = obs.Notebook(obs.js('html`<p>Hello from Observable</p>`'))
full_view = notebook.view()
full_view
```

Read synchronized values from that view after the browser has rendered it.

```python
full_view.runtime_values
```

## marimo

Wrap each view separately with `mo.ui.anywidget`.

```python
import marimo as mo
import observablejs as obs

notebook = obs.Notebook(obs.js('html`<p>Hello from Observable</p>`'))
full_view = notebook.view()
widget = mo.ui.anywidget(full_view)
widget
```

Keep the wrapper mounted while Python controls update session variables.

```python
slider = mo.ui.slider(0, 10, value=5)

notebook = obs.Notebook(
    obs.js('html`<p>Value is <strong>${value}</strong>.</p>`'),
    variables={"value": slider.value},
)
full_view = notebook.view()
widget = mo.ui.anywidget(full_view)
```

```python
notebook.update_variables(value=slider.value)
mo.vstack([slider, widget])
```

Create and wrap another view when the page needs a focused output.

```python
data_view = notebook.cell_at(0).view()
data_widget = mo.ui.anywidget(data_view)
```

## Shared state and view-local runtime

Views from the same notebook share named Python variables and browser-owned
`viewof` input values. Each view owns its Notebook Kit runtime, graph snapshot,
and value readback. Read a value from the view that rendered it.

Use a composite view when selected cells need one runtime and one readback
snapshot.

```python
summary_view = notebook.view(cells=[0, 1])
summary_widget = mo.ui.anywidget(summary_view)
```
