---
title: pyobservablejs
description: Observable JavaScript notebooks as reusable Python widgets.
---

# pyobservablejs

`pyobservablejs` renders Observable JavaScript notebooks as Python widgets.
Python builds the notebook model and synced variables. The browser runs Observable
Notebook Kit, renders cells, and sends values and graph metadata back through
traitlets.

```python
import pyobservablejs as obs

rows = [
    {"letter": "A", "frequency": 0.0812},
    {"letter": "B", "frequency": 0.0149},
    {"letter": "C", "frequency": 0.0271},
]

obs.Notebook(
    obs.md("# Letter frequencies"),
    obs.ojs("""
    Plot.plot({
      y: {grid: true},
      marks: [Plot.barY(rows, {x: "letter", y: "frequency"})]
    })
    """),
    variables={"rows": rows},
)
```

## Core Model

- `obs.Notebook(...)` creates one Observable notebook from Python-authored cells.
- `variables={...}` sets ordinary OJS variables and overrides matching notebook
  variables.
- `notebook.update_variables(...)` mutates those Python-backed values in the live
  runtime.
- Cells with `name=` provide Python names for display and value sync.
- Notebook Kit HTML and public Observable notebooks enter the same runtime path.
- `notebook.graph` reports Notebook Kit-derived definitions, references, and
  dependency edges after the browser renders.
- anywidget composition lets notebook and cell widgets render in Jupyter,
  marimo, and compatible frontends.

:::{tip}
Use `obs.Notebook.from_file(...)` when you already have Notebook Kit HTML. Use
`obs.Notebook(...)` for Python-authored cells.
:::

## Read Next

- [](./quickstart.md): create a notebook, pass Python values, and display cells.
- [](./concepts.md): learn the Observable, Notebook Kit, and widget vocabulary.
- [](./architecture.md): follow the Python-to-browser runtime path.
- [](./composition.md): see how anywidget composition makes cell widgets work.
- [](./api.md): reference the public Python API.
- [](./development.md): build, test, and work on the project locally.
