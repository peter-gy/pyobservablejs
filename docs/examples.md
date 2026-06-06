---
title: Examples
description: Small pyobservablejs examples for common notebook tasks.
---

# Examples

These examples use the public Python API and render in compatible anywidget
frontends.

The snippets below assume this import:

```python
import pyobservablejs as obs
```

## Plot Python Records

Pass row dictionaries with `variables` and read them as normal OJS variables.

```python
rows = [
    {"letter": "A", "frequency": 0.0812},
    {"letter": "B", "frequency": 0.0149},
    {"letter": "C", "frequency": 0.0271},
]

obs.Notebook(
    obs.ojs("""
    Plot.plot({
      y: {grid: true},
      marks: [Plot.barY(rows, {x: "letter", y: "frequency"})]
    })
    """),
    variables={"rows": rows},
)
```

## Update Python Values

Use `update_variables` when the notebook stays the same and Python supplies new
values.

```python
notebook = obs.Notebook(
    obs.ojs("value = gain * 2", name="value"),
    variables={"gain": 3},
)

notebook
```

After the widget has rendered, patch the variable and read the synced result
from a later Python cell:

```python
notebook.update_variables(gain=7)
notebook.value("value")  # 14
```

## Read an Input

Name a `viewof` cell and display the parent notebook.

```python
notebook = obs.Notebook(
    obs.ojs('viewof gain = Inputs.range([0, 10], {value: 5})', name="gain"),
    obs.ojs("double = gain * 2", name="double"),
)

notebook
```

After the notebook has rendered in the browser, use the `NotebookCell` handle or
the parent notebook to read synchronized values from a later Python cell:

```python
notebook.cell("gain").value  # 5
notebook.value("gain")  # 5
notebook.value("double")  # 10
```

## Load Notebook Kit HTML

Use `from_html` for existing Notebook Kit output. It accepts an HTML string, so
the loading step stays under your control. Local attachments and relative imports
are embedded by default when `base_path` is set. Local JavaScript imports are
embedded recursively.

```python
from pathlib import Path

path = Path("chart.html")
notebook = obs.Notebook.from_html(
    path.read_text(encoding="utf-8"),
    base_path=path.parent,
)
notebook
```

Use `portable=False` when the rendered widget should keep the original source
references. Those paths resolve relative to the frontend page URL.

## Load a Public ObservableHQ Notebook

Use `from_observablehq` with a full ObservableHQ URL, notebook slug, or document id.

```python
notebook = obs.Notebook.from_observablehq(
    "https://observablehq.com/@mbostock/saving-svg",
)
notebook
```

Pass `variables` to replace named variables from the loaded notebook with Python
values.

Public notebooks are fetched from ObservableHQ's document API. Uploaded files
stay as remote attachment URLs unless you override them with `attachments`.
