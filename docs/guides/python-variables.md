---
title: Update from Python
description: Update a mounted Observable chart from a Python control.
---

# Update from Python

`variables` gives Python ownership of named values in the Observable graph.
`update_variables` changes those values while the displayed widget stays
mounted.

Try moving the minimum body mass slider. The chart filters the built-in Palmer
Penguins sample.

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

minimum_mass = mo.ui.slider(
    start=3000,
    stop=6000,
    step=250,
    value=4000,
    label="Minimum body mass (g)",
)
```

```{marimo} python
:echo: true

notebook = obs.Notebook(
    obs.js(
        """
        const selectedPenguins = penguins.filter(
          (d) => d.body_mass_g >= minimumMass
        );
        """,
        key="selected_penguins",
        display=False,
    ),
    obs.js(
        """
        Plot.barX(
          selectedPenguins,
          Plot.groupY(
            {x: "count"},
            {y: "species", fill: "species", tip: true}
          )
        ).plot({
          height: 240,
          marginLeft: 76,
          color: {legend: true},
          x: {grid: true, label: "Penguins at or above the threshold"},
          y: {label: null}
        })
        """,
        key="chart",
    ),
    variables={"minimumMass": 4000},
)

widget = mo.ui.anywidget(notebook)
```

```{marimo} python
:echo: true

notebook.update_variables(minimumMass=minimum_mass.value)
mo.vstack([minimum_mass, widget])
```

The final cell updates one Python-owned variable and returns the existing
`widget`. Notebook Kit invalidates the two JavaScript cells that depend on
`minimumMass`.

## Update, replace, or release

`update_variables` merges values into the current environment.

```python
notebook.update_variables({"minimumMass": 3500})
notebook.update_variables(minimumMass=4500)
```

`replace_variables` replaces the Python-owned environment. Names omitted from
the mapping return to the Observable runtime.

```python
notebook.replace_variables({"minimumMass": 4000})
```

`reset_variables` releases selected names.

```python
notebook.reset_variables("minimumMass")
```

See [Variables](../reference/variables.md) for serialization rules and supported
Python values.
