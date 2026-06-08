---
title: Quickstart
description: Install pyobservablejs and render a Notebook Kit notebook from Python.
---

# Quickstart

## Install

```sh
pip install pyobservablejs
```

or with `uv`:

```sh
uv add pyobservablejs
```

## Render a Notebook

`obs.Notebook` accepts Python-authored cells. `variables` exposes Python values
as Observable variables, so OJS cells can read them directly.

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

weekly_metrics = [
    {"week": "Jan 1", "signups": 128, "activations": 93},
    {"week": "Jan 8", "signups": 164, "activations": 117},
    {"week": "Jan 15", "signups": 151, "activations": 132},
    {"week": "Jan 22", "signups": 186, "activations": 145},
    {"week": "Jan 29", "signups": 214, "activations": 173},
]

metrics = obs.Notebook(
    obs.md("# Onboarding metrics"),
    obs.ojs(
        'viewof metric = Inputs.radio(["signups", "activations"], '
        '{value: "signups", label: "metric"})',
        name="metric",
    ),
    obs.ojs(
        """
        selected = weeklyMetrics.map((d) => ({
          week: d.week,
          value: d[metric]
        }))
        """,
        name="selected",
        display=False,
    ),
    obs.ojs(
        """
        Plot.plot({
          height: 230,
          marginLeft: 48,
          y: {grid: true, label: metric},
          marks: [
            Plot.lineY(selected, {
              x: "week",
              y: "value",
              marker: true,
              stroke: "#4269d0",
              tip: true
            })
          ]
        })
        """,
        name="chart",
    ),
    variables={"weeklyMetrics": weekly_metrics},
)

mo.ui.anywidget(metrics)
```

```{marimo} python
:include: false

import marimo as mo
import pyobservablejs as obs
```

```{marimo} python
:include: false

weekly_metrics = [
    {"week": "Jan 1", "signups": 128, "activations": 93},
    {"week": "Jan 8", "signups": 164, "activations": 117},
    {"week": "Jan 15", "signups": 151, "activations": 132},
    {"week": "Jan 22", "signups": 186, "activations": 145},
    {"week": "Jan 29", "signups": 214, "activations": 173},
]
```

```{marimo} python
:include: false

metrics = obs.Notebook(
    obs.md("# Onboarding metrics"),
    obs.ojs(
        'viewof metric = Inputs.radio(["signups", "activations"], '
        '{value: "signups", label: "metric"})',
        name="metric",
    ),
    obs.ojs(
        """
        selected = weeklyMetrics.map((d) => ({
          week: d.week,
          value: d[metric]
        }))
        """,
        name="selected",
        display=False,
    ),
    obs.ojs(
        """
        Plot.plot({
          height: 230,
          marginLeft: 48,
          y: {grid: true, label: metric},
          marks: [
            Plot.lineY(selected, {
              x: "week",
              y: "value",
              marker: true,
              stroke: "#4269d0",
              tip: true
            })
          ]
        })
        """,
        name="chart",
    ),
    variables={"weeklyMetrics": weekly_metrics},
)
```

```{marimo} python
mo.ui.anywidget(metrics)
```

Change the metric input. Observable recomputes `selected` and `chart` in the
browser because both cells depend on the `viewof metric` value.

What happens here:

- `obs.Notebook(...)` creates one Notebook Kit notebook.
- `obs.md(...)` and `obs.ojs(...)` keep each cell's source mode explicit.
- `variables={"weeklyMetrics": weekly_metrics}` sends Python records into OJS.
- `name="metric"` gives Python a stable handle for the input cell.
- `display=False` keeps the derived `selected` cell out of the rendered notebook.

## Update Python Variables

Use `update_variables` when the notebook stays the same and Python supplies new
values.

```python
metrics.update_variables(
    weeklyMetrics=[
        {"week": "Feb 5", "signups": 232, "activations": 181},
        {"week": "Feb 12", "signups": 245, "activations": 205},
    ],
)
```

Use `replace_variables` when omitted names should return to the notebook's own
Observable definitions.

```python
metrics.replace_variables({"weeklyMetrics": weekly_metrics[-3:]})
```

## Read One Cell

Name cells that Python needs to read after the notebook renders.

```python
notebook = obs.Notebook(
    obs.ojs('viewof gain = Inputs.range([0, 11], {value: 5})', name="gain"),
    obs.ojs("double = gain * 2", name="double"),
)

notebook
```

`notebook.cell("gain")` returns the `NotebookCell` handle for the named cell.
After the parent notebook has rendered in the browser, read synchronized values
from a later Python cell:

```python
notebook.cell("gain").value
notebook.value("double")
```

Use `NotebookCell` handles for values and graph metadata. Display the parent
`Notebook` to render Observable outputs.

## Load Notebook Kit HTML

Use `from_html` when you already have Notebook Kit HTML. The method accepts the
HTML string directly, whether you read it from a file, database, or custom
loader.

```python
from pathlib import Path

path = Path("chart.html")
notebook = obs.Notebook.from_html(
    path.read_text(encoding="utf-8"),
    base_path=path.parent,
)
```

By default, local `FileAttachment(...)` references and relative JavaScript
imports are embedded when `base_path` is set. Local JavaScript imports are
embedded recursively. With `portable=False`, source references stay unchanged and
resolve relative to the frontend page URL.

## Load a Public ObservableHQ Notebook

Use `from_observablehq` for a public ObservableHQ notebook:

```python
notebook = obs.Notebook.from_observablehq("https://observablehq.com/@mbostock/saving-svg")
notebook
```

The specifier can be a full ObservableHQ URL, a slug such as
`@mbostock/saving-svg`, a 16-character notebook id, or an ObservableHQ document
API URL. Remote file attachments are kept as URL-backed attachments.

Use the same `variables` mapping to override variables in a public notebook:

```python
penguins = [
    {"culmen_length_mm": 36.7, "culmen_depth_mm": 18.4},
    {"culmen_length_mm": 44.1, "culmen_depth_mm": 15.9},
    {"culmen_length_mm": 50.2, "culmen_depth_mm": 19.1},
]
notebook = obs.Notebook.from_observablehq(
    "https://observablehq.com/@observablehq/plot-scatterplot/2",
    variables={"penguins": penguins},
)
```
