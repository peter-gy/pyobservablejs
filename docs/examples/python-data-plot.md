---
title: Python data to Plot
description: Pass Palmer Penguins records from Python to Observable Plot.
---

# Python data to Plot

A Python list of dictionaries becomes a JavaScript array of objects in Notebook
Kit. This example passes species counts from the [Palmer Penguins
dataset](https://allisonhorst.github.io/palmerpenguins/) to Observable Plot.

Hover a bar to inspect the count for one species.

The browser loads Plot for this example. See [Notebook
runtime](../guides/notebook-runtime.md#builtins) for network and content
security policy requirements.

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

The `variables` mapping publishes the Python list under the JavaScript name
`penguinCounts`. The JavaScript cell reads it directly.

## Continue

- [Variables](../reference/variables.md) lists the supported Python value types.
- [Python variables](../guides/python-variables.md) updates values after render.
