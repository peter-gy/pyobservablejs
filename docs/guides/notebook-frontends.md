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

Other anywidget frontends may work when they can display the `Notebook` and
resolve its child `NotebookCell` models. That support is required for direct
cell display and synchronized per-cell values.

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

A `NotebookCell` can be displayed after it has been created by a parent
`Notebook`. The standalone view evaluates the selected cell and its dependencies
in the parent notebook context.

```python
notebook = obs.Notebook(
    obs.js("const answer = 42;", key="answer"),
    obs.js('html`<p>Answer is ${answer}.</p>`', key="readout"),
)

mo.ui.anywidget(notebook.cell_by_key("readout"))
```

The standalone display syncs values to the displayed `NotebookCell` and syncs
graph metadata through the parent `Notebook`. Display the parent `Notebook` when
you want every cell output in notebook order.
