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

Other anywidget frontends may work when they support anywidget model display and
can resolve child widget models. Child resolution is required before
`NotebookCell` values and graph metadata are available.

## Jupyter

Display the notebook object as the last expression in a cell.

```python
import observablejs as obs

notebook = obs.Notebook(obs.ojs("md`Hello from Observable`"))
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

notebook = obs.Notebook(obs.ojs("md`Hello from Observable`"))
view = mo.ui.anywidget(notebook)
view
```

Keep the widget mounted when Python controls update variables. Create the widget
once, then call `update_variables` from a dependent cell.

```python
slider = mo.ui.slider(0, 10, value=5)

notebook = obs.Notebook(
    obs.ojs("md`value is ${value}`"),
    variables={"value": slider.value},
)
view = mo.ui.anywidget(notebook)
```

```python
notebook.update_variables(value=slider.value)
mo.vstack([slider, view])
```

## Direct cell display

Display the parent `Notebook`, not the child `NotebookCell`. Child cell widgets
depend on the parent runtime and graph. Use child widgets for Python-side value
and metadata reads.
