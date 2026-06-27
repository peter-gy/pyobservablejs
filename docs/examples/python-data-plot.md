---
title: Python data plot
description: Pass Python records to Observable Plot.
---

# Python data plot

Python data arrives in OJS as a normal variable. This example uses Python
records and an Observable Plot bar chart.

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

incidents = [
    {"service": "api", "severity": "high", "count": 7},
    {"service": "api", "severity": "low", "count": 18},
    {"service": "worker", "severity": "high", "count": 4},
    {"service": "worker", "severity": "low", "count": 11},
    {"service": "docs", "severity": "high", "count": 2},
    {"service": "docs", "severity": "low", "count": 6},
]

notebook = obs.Notebook(
    obs.md("# Incidents by service"),
    obs.ojs(
        """
        Plot.plot({
          height: 260,
          marginLeft: 56,
          color: {legend: true},
          y: {grid: true},
          marks: [
            Plot.barY(incidents, {
              x: "service",
              y: "count",
              fill: "severity",
              tip: true
            })
          ]
        })
        """,
        key="chart",
    ),
    variables={"incidents": incidents},
)

mo.ui.anywidget(notebook)
```

The chart groups service counts by severity. Hover a bar to see the exact count.

The Python variable is named `incidents`. The OJS cell reads `incidents` without
an import or callback.

## Continue

- [Variables](../reference/variables.md) lists the supported Python value types.
- [Cells](../reference/cells.md) covers the helper options used by the example.
