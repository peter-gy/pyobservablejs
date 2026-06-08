---
title: pyobservablejs
description: Observable JavaScript notebooks as reusable Python widgets.
---

# pyobservablejs

`pyobservablejs` renders Observable JavaScript notebooks from Python. Build cells,
pass Python values, load Notebook Kit HTML, or reuse public ObservableHQ notebooks.
The browser runs Notebook Kit and returns values through widget traits.

```python
import pyobservablejs as obs

weekly_metrics = [
    {"week": "Jan 1", "signups": 128, "activations": 93},
    {"week": "Jan 8", "signups": 164, "activations": 117},
    {"week": "Jan 15", "signups": 151, "activations": 132},
    {"week": "Jan 22", "signups": 186, "activations": 145},
]

obs.Notebook(
    obs.md("# Onboarding metrics"),
    obs.ojs(
        'viewof metric = Inputs.radio(["signups", "activations"], '
        '{value: "signups", label: "metric"})',
        name="metric",
    ),
    obs.ojs("""
    Plot.plot({
      height: 220,
      y: {grid: true},
      marks: [
        Plot.lineY(weeklyMetrics, {x: "week", y: metric, marker: true})
      ]
    })
    """),
    variables={"weeklyMetrics": weekly_metrics},
)
```

The quickstart renders this pattern as live documentation. Change the Observable
input and Notebook Kit recomputes the dependent Plot cell in the browser.

## Core Model

- `obs.Notebook(...)` creates one Observable notebook from Python-authored cells.
- `variables={...}` sets ordinary OJS variables and overrides matching notebook
  variables.
- `notebook.update_variables(...)` mutates those Python-backed values in the live
  runtime.
- Cells with `name=` provide Python handles for value reads and graph metadata
  after displaying the parent `Notebook`.
- Notebook Kit HTML strings and public ObservableHQ notebooks use the same
  rendering path as Python-authored notebooks.
- The widget renders in Jupyter, marimo, and compatible anywidget frontends.

:::{tip}
Use `obs.Notebook.from_html(...)` when you already have Notebook Kit HTML. Use
`obs.Notebook(...)` for Python-authored cells.
:::

## Read Next

- [](./quickstart.md): create a notebook, pass Python values, and display cells.
- [](./examples.md): try compact rendered examples for common notebook tasks.
- [](./tutorials/index.md): use `pyobservablejs` in notebook frontends such as marimo.
- [](./concepts.md): learn the Observable, Notebook Kit, and widget vocabulary.
- [](./api.md): reference the public Python API.
- [](./architecture.md): follow the Python-to-browser runtime path.
- [](./composition.md): see how anywidget composition makes cell widgets work.
- [](./development.md): build, test, and work on the project locally.
