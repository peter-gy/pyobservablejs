---
title: Filter in Observable
description: Use a Notebook Kit input to filter a cars scatter plot.
---

# Filter in Observable

Notebook Kit inputs can own interaction entirely in the browser. Try choosing a
cylinder count. The scatter plot updates immediately. `cars` is a sample dataset
provided by Notebook Kit.

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
        const cylinders = view(Inputs.select(
          ["All", ...new Set(cars.map((d) => d.cylinders))],
          {label: "Cylinders", value: "All"}
        ));
        """,
        key="cylinder_control",
    ),
    obs.js(
        """
        const filteredCars = cylinders === "All"
          ? cars
          : cars.filter((d) => d.cylinders === cylinders);
        """,
        key="filtered_cars",
        display=False,
    ),
    obs.js(
        """
        Plot.dot(filteredCars, {
          x: "weight (lb)",
          y: "economy (mpg)",
          fill: "cylinders",
          r: 4,
          opacity: 0.72,
          tip: true
        }).plot({
          height: 320,
          color: {legend: true},
          x: {grid: true, label: "Weight (lb)"},
          y: {grid: true, label: "Fuel economy (mpg)"}
        })
        """,
        key="chart",
    ),
)

full_view = notebook.view()
mo.ui.anywidget(full_view)
```

The input defines `cylinders`. The hidden cell derives `filteredCars`. The chart
references that derived value, so Notebook Kit records both graph edges.

Python creates one full view. Its browser runtime updates the selection and
dependent cells.

## Continue

- [Observable cells and reactivity](../guides/author-cells.md) explains
  expression cells, program cells, and graph invalidation.
- [Values back to Python](../guides/cell-values.md) reads synchronized values
  after render.
