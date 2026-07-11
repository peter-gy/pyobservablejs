---
title: Notebook frontends
description: Display pyobservablejs notebooks in Jupyter and marimo.
---

# Notebook frontends

`Notebook` is an anywidget model. Jupyter can display the object directly. In
marimo, wrap it with `mo.ui.anywidget`.

| Frontend   | Install                                 | Start                  | Display                     |
| ---------- | --------------------------------------- | ---------------------- | --------------------------- |
| JupyterLab | `pip install pyobservablejs jupyterlab` | `jupyter lab`          | `notebook`                  |
| marimo     | `pip install pyobservablejs marimo`     | `marimo edit first.py` | `mo.ui.anywidget(notebook)` |

Other frontends can display a full `Notebook` through the standard Anywidget
Front-End Module (AFM) render lifecycle. Direct `NotebookCell` display also uses
the `host.getWidget` composition API available as of anywidget 0.11 so the
projection can ask its parent `Notebook` to render into the cell view.

| Display object | Frontend contract                          |
| -------------- | ------------------------------------------ |
| `Notebook`     | AFM render lifecycle                       |
| `NotebookCell` | AFM `host.getWidget` composition from 0.11 |

## Jupyter

Display the notebook object as the last expression in a cell.

```python
import observablejs as obs

notebook = obs.Notebook(obs.js('html`<p>Hello from Observable</p>`'))
notebook
```

Read synchronized values from a later Python cell after the browser has rendered
the widget.

```python
notebook.runtime_values
```

## marimo

Wrap the notebook in `mo.ui.anywidget`.

```python
import marimo as mo
import observablejs as obs

notebook = obs.Notebook(obs.js('html`<p>Hello from Observable</p>`'))
view = mo.ui.anywidget(notebook)
view
```

Keep the widget mounted when Python controls update variables. Create the widget
once, then call `update_variables` from a dependent cell.

```python
slider = mo.ui.slider(0, 10, value=5)

notebook = obs.Notebook(
    obs.js('html`<p>Value is <strong>${value}</strong>.</p>`'),
    variables={"value": slider.value},
)
view = mo.ui.anywidget(notebook)
```

```python
notebook.update_variables(value=slider.value)
mo.vstack([slider, view])
```

## Direct cell display

A `NotebookCell` is materialized when `cell_at`, `cell_by_key`,
`cell_for_variable`, or `cells` requests it. The standalone view evaluates the
selected cell and its dependencies in the parent notebook context.

```python
notebook = obs.Notebook(
    obs.js("const answer = 42;", key="answer"),
    obs.js('html`<p>Answer is ${answer}.</p>`', key="readout"),
)

mo.ui.anywidget(notebook.cell_by_key("readout"))
```

The standalone display writes the cell values and graph metadata to the parent
`Notebook` snapshot read by the projection handle. Display the parent
`Notebook` when you want every cell output in notebook order.
