---
title: observablejs
description: Observable JavaScript notebooks as reusable Python widgets.
---

# observablejs

`observablejs` lets Python users create, display, and compose Observable
JavaScript notebooks.

Write Observable cells in Python, pass Python data into the browser runtime, and
display either the full notebook or a named cell.

```python
import observablejs as ojs

rows = [
    {"letter": "A", "frequency": 0.0812},
    {"letter": "B", "frequency": 0.0149},
    {"letter": "C", "frequency": 0.0271},
]

ojs.Notebook(
    ojs.md("# Letter frequencies"),
    ojs.cell("""
    Plot.plot({
      y: {grid: true},
      marks: [Plot.barY(rows, {x: "letter", y: "frequency"})]
    })
    """),
    data={"rows": rows},
)
```

## What It Gives You

- Full Observable JavaScript cells from Python.
- Python values available as normal OJS variables.
- Named cell handles for displaying or reading individual cells.
- Notebook Kit HTML import for existing Observable-style notebooks.
- Public Observable notebook URL loading.
- Portable file attachments and local JavaScript imports.
- anywidget packaging, so the same object works in Jupyter, marimo, and other
  compatible frontends.

## Read Next

- [](./quickstart.md): create your first notebook and pass data from Python.
- [](./concepts.md): learn the Observable, Notebook Kit, and widget vocabulary.
- [](./architecture.md): follow the Python-to-browser data flow.
- [](./api.md): see the public API in one place.
- [](./development.md): build, test, and work on the project locally.
