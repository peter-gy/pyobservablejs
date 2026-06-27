---
title: Reactive inputs
description: Use Observable inputs to recompute dependent cells.
---

# Reactive inputs

Observable `viewof` inputs update dependent cells in the browser. Python only
needs to create and display the notebook.

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

rows = [
    {"region": "west", "product": "alpha", "revenue": 42},
    {"region": "west", "product": "beta", "revenue": 31},
    {"region": "east", "product": "alpha", "revenue": 27},
    {"region": "east", "product": "beta", "revenue": 36},
]

notebook = obs.Notebook(
    obs.ojs(
        """
        viewof region = Inputs.select(
          ["all", ...new Set(rows.map((d) => d.region))],
          {value: "all", label: "region"}
        )
        """,
        key="region_control",
    ),
    obs.ojs(
        """
        selectedRows = region === "all"
          ? rows
          : rows.filter((d) => d.region === region)
        """,
        key="selected_rows",
        display=False,
    ),
    obs.ojs(
        """
        Plot.plot({
          height: 240,
          marginLeft: 56,
          y: {grid: true},
          marks: [
            Plot.barY(selectedRows, {x: "product", y: "revenue", tip: true})
          ]
        })
        """,
        key="chart",
    ),
    variables={"rows": rows},
)

mo.ui.anywidget(notebook)
```

Select `east` or `west` to filter the chart to that region. Select `all` to show
every row again.

The `selectedRows` cell is hidden from the page, but its value participates in
the Observable graph.

## Continue

- [Cell values](../guides/cell-values.md) shows how to read browser-synchronized
  values from Python after render.
- [Cells](../reference/cells.md) covers hidden cells and helper options.
