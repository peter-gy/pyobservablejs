---
title: Getting started
description: Build and display a pyobservablejs notebook.
---

# Getting started

`pyobservablejs` supports Python 3.11 or newer. Install it in the same
environment as the notebook frontend you plan to use.

```sh
pip install pyobservablejs jupyterlab
jupyter lab
```

For marimo:

```sh
pip install pyobservablejs marimo
marimo edit first.py
```

The first notebook below passes Python records into Observable JavaScript, then
renders an Observable Plot chart. Move the metric control to change the chart in
the browser.

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

weekly_metrics = [
    {"week": "2026-05-04", "done": 12, "blocked": 3},
    {"week": "2026-05-11", "done": 15, "blocked": 2},
    {"week": "2026-05-18", "done": 9, "blocked": 5},
    {"week": "2026-05-25", "done": 18, "blocked": 1},
]

notebook = obs.Notebook(
    obs.md("# Weekly work"),
    obs.ojs(
        'viewof metric = Inputs.radio(["done", "blocked"], {value: "done"})',
        key="metric_control",
    ),
    obs.ojs(
        """
        Plot.plot({
          height: 240,
          marginLeft: 48,
          y: {grid: true},
          marks: [
            Plot.lineY(weeklyMetrics, {x: "week", y: metric, tip: true}),
            Plot.dot(weeklyMetrics, {x: "week", y: metric, fill: "currentColor"})
          ]
        })
        """,
        key="trend",
    ),
    variables={"weeklyMetrics": weekly_metrics},
)

mo.ui.anywidget(notebook)
```

The output shows the `Weekly work` title, a `done` or `blocked` metric radio
control, and a Plot chart. Changing the metric recomputes the chart in the
browser.

## What the code does

`obs.Notebook(...)` creates a Notebook Kit document. `obs.ojs(...)` cells run as
Observable JavaScript. The `variables` mapping makes `weeklyMetrics` available
to OJS as a normal variable.

Changing `metric` recomputes the dependent OJS cells in the browser, so the
chart updates without a Python callback.

The example uses `mo.ui.anywidget(notebook)` for marimo. In Jupyter, display
`notebook` directly as the final expression.

## Next steps

- Use [Python variables](guides/python-variables.md) when Python controls should
  update a displayed notebook.
- Use [source HTML](guides/source-html.md) when you already have Notebook Kit
  HTML.
- Use [cell values](guides/cell-values.md) when Python needs values computed by
  the browser runtime.
