---
title: Python variables
description: Pass Python values into Observable JavaScript and update them live.
---

# Python variables

`variables` makes Python values available to Observable JavaScript by name. Use
`update_variables` when a live Python control changes a value and the displayed
widget should stay mounted.

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

minimum = mo.ui.slider(
    start=0,
    stop=24,
    step=1,
    value=10,
    label="minimum done",
)
```

```{marimo} python
:echo: true

rows = [
    {"team": "alpha", "done": 18, "blocked": 2},
    {"team": "beta", "done": 13, "blocked": 5},
    {"team": "gamma", "done": 21, "blocked": 1},
    {"team": "delta", "done": 8, "blocked": 7},
]

notebook = obs.Notebook(
    obs.ojs(
        """
        filteredRows = rows.filter((d) => d.done >= minimumDone)
        """,
        key="filtered_rows",
        display=False,
    ),
    obs.ojs(
        """
        Plot.plot({
          height: 240,
          marginLeft: 52,
          y: {grid: true},
          marks: [
            Plot.barY(filteredRows, {x: "team", y: "done", tip: true})
          ]
        })
        """,
        key="chart",
    ),
    variables={"rows": rows, "minimumDone": 10},
)
view = mo.ui.anywidget(notebook)
```

```{marimo} python
:echo: true

notebook.update_variables(minimumDone=minimum.value)
mo.vstack([minimum, view])
```

Move `minimum done` from 10 to 18. The chart drops rows below the threshold
without remounting the widget.

`update_variables` merges the supplied names into the current variable
environment.

```python
notebook.update_variables(minimumDone=12)
notebook.update_variables({"rows": rows}, minimumDone=6)
```

Use `replace_variables` when Python should replace the whole environment.
Names omitted from the replacement are released back to the Observable runtime.

```python
notebook.replace_variables({"rows": rows})
```

Use `reset_variables` when only a few Python-owned names should be released.

```python
notebook.reset_variables("minimumDone")
```

## Supported values

Variable names must be JavaScript identifiers. Values are serialized before
they cross the widget boundary.

| Python value                          | Observable value     |
| ------------------------------------- | -------------------- |
| `dict`, `list`, `tuple`, `range`      | Objects and arrays   |
| `int`, `float`, `bool`, `str`, `None` | JSON-like primitives |
| Large `int` values                    | `BigInt`             |
| `datetime.date`, `datetime.datetime`  | `Date`               |
| `bytes`, `bytearray`, `memoryview`    | Byte arrays          |
| pandas and Polars dataframes          | Row records          |
| pandas and Polars series              | Arrays               |
| NumPy arrays and scalars              | Lists and scalars    |

Large tables travel through traitlets. For repeated high-volume updates, prefer
loading a file with `FileAttachment` and updating small filter variables.
