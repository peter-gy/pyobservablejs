---
title: pyobservablejs
description: Observable JavaScript notebooks from Python.
---

# pyobservablejs

`pyobservablejs` renders Observable JavaScript notebooks in Jupyter and marimo.
`Notebook` collects cells, variables, and attachments. Call `view()` to create
a renderable view of the notebook or a selected group of cells.

Install the package in the same environment as your notebook frontend.

```sh
pip install pyobservablejs jupyterlab
```

For marimo, replace `jupyterlab` with `marimo`.

The example uses Notebook Kit's built-in Palmer Penguins sample. Hover a dot to
inspect a measurement.

The browser loads the library and sample data used here. See [Notebook
runtime](guides/notebook-runtime.md#builtins) for network and content security
policy requirements.

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
    obs.js(
        """
        Plot.dot(penguins, {
          x: "culmen_length_mm",
          y: "culmen_depth_mm",
          fill: "species",
          r: 4,
          tip: true
        }).plot({
          height: 320,
          color: {legend: true},
          x: {grid: true, label: "Bill length (mm)"},
          y: {grid: true, label: "Bill depth (mm)"}
        })
        """
    ),
)

full_view = notebook.view()
mo.ui.anywidget(full_view)
```

`Notebook` accepts JavaScript, Observable JavaScript, Markdown, and HTML cells.

## Start with a workflow

::::{grid} 1 1 2 2

:::{card} Build your first notebook
:link: getting-started.md

Create a reactive Plot chart and render its view in Jupyter or marimo.
:::

:::{card} Pass Python data
:link: examples/python-data-plot.md

Publish Python records as a JavaScript variable and render them with Plot.
:::

:::{card} React in the browser
:link: examples/reactive-inputs.md

Connect an Observable input to a dependent chart.
:::

:::{card} Update from Python
:link: guides/python-variables.md

Drive a mounted view from a marimo control.
:::

::::

Use the [examples](examples/index.md) for complete workflows. The [views and
composition guide](guides/views-and-composition.md) explains cell selection,
mounting, variable sharing, and readback. The
[reference](reference/index.md) covers signatures, defaults, and lifecycle
rules.
