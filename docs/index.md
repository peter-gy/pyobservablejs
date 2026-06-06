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
- [](./examples.md): copy small examples for common notebook tasks.
- [](./tutorials/index.md): use `pyobservablejs` in notebook frontends such as marimo.
- [](./concepts.md): learn the Observable, Notebook Kit, and widget vocabulary.
- [](./api.md): reference the public Python API.
- [](./architecture.md): follow the Python-to-browser runtime path.
- [](./composition.md): see how anywidget composition makes cell widgets work.
- [](./development.md): build, test, and work on the project locally.
