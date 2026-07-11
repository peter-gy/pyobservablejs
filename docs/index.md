---
title: pyobservablejs
description: Observable JavaScript notebooks from Python.
---

# pyobservablejs

`pyobservablejs` renders Observable JavaScript notebooks in Jupyter and marimo.
`Notebook` stores the definition and shared session state. `NotebookView` runs
its selected cells through Notebook Kit in the browser.

The example uses Notebook Kit's built-in Palmer Penguins sample. Hover a dot to
inspect a measurement.

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

Adelie, Chinstrap, and Gentoo penguins form visibly different bill profiles.

Install the package in the same environment as your notebook frontend.

```sh
pip install pyobservablejs jupyterlab
```

The distribution is named `pyobservablejs`. Python code imports it as
`observablejs`.

`Notebook` accepts JavaScript, Observable JavaScript, Markdown, and HTML cells.
It also accepts Python variables and local file attachments.

## Start with a workflow

::::{grid} 1 1 2 2

:::{card} Build your first notebook
:link: getting-started.md

Create a reactive Plot chart and render its view in Jupyter or marimo.
:::

:::{card} Pass Python data
:link: examples/python-data-plot.md

Serialize Python records into a Notebook Kit cell.
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

Use the [examples](examples/index.md) for complete workflows and the
[reference](reference/index.md) for signatures, defaults, and lifecycle rules.
