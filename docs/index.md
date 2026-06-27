---
title: pyobservablejs
description: Observable JavaScript notebooks from Python.
---

# pyobservablejs

`pyobservablejs` renders Observable JavaScript notebooks from Python. A
`Notebook` holds Observable cells, Python-owned variables, file attachments, and
theme settings. Jupyter and marimo display it as an anywidget. The browser runs
the Observable graph.

```python
import observablejs as obs

notebook = obs.Notebook(
    obs.md("# Letter frequencies"),
    obs.ojs('viewof floor = Inputs.range([0, 0.12], {value: 0.04, step: 0.01})'),
    obs.ojs("""
    Plot.plot({
      height: 240,
      y: {grid: true},
      marks: [
        Plot.ruleY([floor]),
        Plot.barY(letters, {x: "letter", y: "frequency", tip: true})
      ]
    })
    """),
    variables={
        "letters": [
            {"letter": "A", "frequency": 0.0812},
            {"letter": "B", "frequency": 0.0149},
            {"letter": "C", "frequency": 0.0271},
        ]
    },
)
```

In a notebook frontend, display `notebook`. In marimo, display
`mo.ui.anywidget(notebook)`.

## Choose a path

- [Getting started](getting-started.md) builds one live notebook and updates it
  with an Observable input.
- [Examples](examples/index.md) are runnable pages with visible source and
  rendered output.
- [Guides](guides/index.md) cover authored cells, Python variables, cell values,
  source HTML, ObservableHQ imports, themes, and frontend hosting.
- [Reference](reference/index.md) gives the supported Python API contracts.
- [Development](development.md) covers local setup, docs builds, and runtime
  internals for contributors.
