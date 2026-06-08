---
title: Python Variables
description: Pass Python values into Observable JavaScript cells and update them.
---

# Python Variables

`variables` exposes Python values as Observable variables. OJS cells read those
names directly, and `update_variables` patches the live runtime after the widget
has rendered.

```{marimo-config}
:pyproject:

  requires-python = ">=3.10"
  dependencies = [
      "pyobservablejs @ https://files.peter.gy/pkg/py/pyobservablejs/pyobservablejs-0.0.0rc1-py3-none-any.whl#sha256=02b7ec0a297f81dd77f425a5e315eba537a71f93d9d58057ea0d004639cd44d8",
  ]
```

```python
import marimo as mo
import pyobservablejs as obs

letters = [
    {"letter": "A", "frequency": 0.0812},
    {"letter": "B", "frequency": 0.0149},
    {"letter": "C", "frequency": 0.0271},
    {"letter": "D", "frequency": 0.0432},
    {"letter": "E", "frequency": 0.1202},
    {"letter": "F", "frequency": 0.0228},
]

INITIAL_FREQUENCY_FLOOR = 0.04

frequency_floor = mo.ui.slider(
    start=0.0,
    stop=0.12,
    step=0.01,
    value=INITIAL_FREQUENCY_FLOOR,
    label="frequency floor",
)

letter_notebook = obs.Notebook(
    obs.md("# Letter frequencies"),
    obs.ojs(
        """
        Plot.plot({
          height: 250,
          marginLeft: 48,
          y: {grid: true, label: "frequency"},
          color: {legend: true},
          marks: [
            Plot.ruleY([frequencyFloor]),
            Plot.barY(letters, {
              x: "letter",
              y: "frequency",
              fill: (d) => d.frequency >= frequencyFloor
                ? "above floor"
                : "below floor",
              tip: true
            })
          ]
        })
        """,
        name="chart",
    ),
    variables={"letters": letters, "frequencyFloor": INITIAL_FREQUENCY_FLOOR},
)
letter_view = mo.ui.anywidget(letter_notebook)

# Put this in a later marimo cell. The display cell for `letter_view` does not
# read `frequency_floor.value`, so the anywidget view stays mounted.
letter_notebook.update_variables(frequencyFloor=frequency_floor.value)

frequency_floor
mo.vstack([letter_view])
```

```{marimo} python
:include: false

import marimo as mo
import pyobservablejs as obs
```

```{marimo} python
:include: false

letters = [
    {"letter": "A", "frequency": 0.0812},
    {"letter": "B", "frequency": 0.0149},
    {"letter": "C", "frequency": 0.0271},
    {"letter": "D", "frequency": 0.0432},
    {"letter": "E", "frequency": 0.1202},
    {"letter": "F", "frequency": 0.0228},
]
INITIAL_FREQUENCY_FLOOR = 0.04
```

```{marimo} python
:include: false

frequency_floor = mo.ui.slider(
    start=0.0,
    stop=0.12,
    step=0.01,
    value=INITIAL_FREQUENCY_FLOOR,
    label="frequency floor",
)
```

```{marimo} python
:include: false

letter_notebook = obs.Notebook(
    obs.md("# Letter frequencies"),
    obs.ojs(
        """
        Plot.plot({
          height: 250,
          marginLeft: 48,
          y: {grid: true, label: "frequency"},
          color: {legend: true},
          marks: [
            Plot.ruleY([frequencyFloor]),
            Plot.barY(letters, {
              x: "letter",
              y: "frequency",
              fill: (d) => d.frequency >= frequencyFloor
                ? "above floor"
                : "below floor",
              tip: true
            })
          ]
        })
        """,
        name="chart",
    ),
    variables={"letters": letters, "frequencyFloor": INITIAL_FREQUENCY_FLOOR},
)
letter_view = mo.ui.anywidget(letter_notebook)
```

```{marimo} python
:include: false

letter_notebook.update_variables(frequencyFloor=frequency_floor.value)
```

```{marimo} python
frequency_floor
```

```{marimo} python
mo.vstack([letter_view])
```

```{marimo} python
mo.md(f"Python-owned `frequencyFloor`: `{frequency_floor.value:.2f}`")
```

Move the slider. Only the update cell reads `frequency_floor.value`. The widget
display cell stays independent of the slider. Notebook Kit redefines
`frequencyFloor` in the existing Observable runtime.

`update_variables` keeps omitted Python-owned names. Use
`replace_variables({...})` when omitted names should return to the notebook's
own Observable definitions.
