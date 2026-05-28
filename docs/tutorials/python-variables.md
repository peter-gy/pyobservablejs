---
title: Python Variables
description: Pass Python values into Observable JavaScript cells.
---

# Python Variables

`variables` exposes Python values as Observable variables. OJS cells read those
names directly.

```python
import marimo as mo
import pyobservablejs as obs

rows = [
    {"day": "Mon", "value": 12},
    {"day": "Tue", "value": 18},
    {"day": "Wed", "value": 15},
]

notebook = obs.Notebook(
    obs.ojs("""
    Plot.plot({
      height: 220,
      y: {grid: true},
      marks: [Plot.lineY(rows, {x: "day", y: "value", marker: true})]
    })
    """),
    variables={"rows": rows},
)

mo.ui.anywidget(notebook)
```

Update the live runtime from a later Python cell:

```python
notebook.update_variables(rows=rows[-2:])
```

`update_variables` keeps omitted Python-owned names. Use
`replace_variables({...})` when omitted names should return to the notebook's
own Observable definitions.
