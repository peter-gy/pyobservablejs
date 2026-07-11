---
title: Python data to Plot
description: Pass Palmer Penguins records from Python to Observable Plot.
---

# Python data to Plot

Python records arrive in Notebook Kit as normal JavaScript values. This example
passes Palmer Penguins species counts to an Observable Plot chart.

Hover a bar to inspect the count for one species.

```{marimo-config}
:pyproject:

  requires-python = ">=3.11"
  dependencies = [
      "pyobservablejs",
  ]
```

```{marimo} python
:echo: false

import marimo as mo
import observablejs as obs

penguin_counts = [
    {"species": "Adelie", "count": 152},
    {"species": "Chinstrap", "count": 68},
    {"species": "Gentoo", "count": 124},
]

notebook = obs.Notebook(
    obs.js(
        """
        Plot.barX(penguinCounts, {
          x: "count",
          y: "species",
          fill: "species",
          tip: true
        }).plot({
          height: 240,
          marginLeft: 76,
          color: {legend: true},
          x: {grid: true, label: "Penguins"},
          y: {label: null}
        })
        """,
    ),
    variables={"penguinCounts": penguin_counts},
)

full_view = notebook.view()
mo.ui.anywidget(full_view)
```

Adelie is the largest species group in the dataset.

The `variables` mapping serializes `penguin_counts` as `penguinCounts`. The
JavaScript cell reads it directly.

The counts come from the [Palmer Penguins
dataset](https://allisonhorst.github.io/palmerpenguins/).

## Source

```python
import marimo as mo
import observablejs as obs

penguin_counts = [
    {"species": "Adelie", "count": 152},
    {"species": "Chinstrap", "count": 68},
    {"species": "Gentoo", "count": 124},
]

notebook = obs.Notebook(
    obs.js(
        """
        Plot.barX(penguinCounts, {
          x: "count",
          y: "species",
          fill: "species",
          tip: true
        }).plot({
          height: 240,
          marginLeft: 76,
          color: {legend: true},
          x: {grid: true, label: "Penguins"},
          y: {label: null}
        })
        """
    ),
    variables={"penguinCounts": penguin_counts},
)

full_view = notebook.view()
mo.ui.anywidget(full_view)
```

## Continue

- [Variables](../reference/variables.md) lists the supported Python value types.
- [Python variables](../guides/python-variables.md) updates values after render.
