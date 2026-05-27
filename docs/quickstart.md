---
title: Quickstart
description: Install pyobservablejs and create a small notebook from Python.
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

For optional dataframe serialization support:

```sh
uv add "pyobservablejs[data]"
```

## Create a Notebook

Use `obs.Notebook` with cell helpers. `obs.ojs` creates Observable JavaScript
cells, `obs.js` creates ES module JavaScript cells, `obs.md` creates Markdown
cells, and `obs.html` creates HTML cells.

```python
import pyobservablejs as obs

notebook = obs.Notebook(
    obs.md("# A small notebook"),
    obs.ojs("answer = 40 + 2", name="answer"),
    obs.ojs("md`The answer is **${answer}**.`"),
)

notebook
```

Displaying `notebook` renders the full Observable notebook in any compatible
widget frontend.

## Pass Python Variables

Pass a mapping with `variables`. Each key becomes an OJS variable name, so keys must
be JavaScript identifiers. If a notebook defines the same variable, the Python
value overrides that definition.

```python
import pyobservablejs as obs

events = [
    {"day": "Mon", "value": 12},
    {"day": "Tue", "value": 18},
    {"day": "Wed", "value": 15},
]

notebook = obs.Notebook(
    obs.ojs("""
    Plot.plot({
      height: 220,
      y: {grid: true},
      marks: [Plot.lineY(events, {x: "day", y: "value", marker: true})]
    })
    """),
    variables={"events": events},
)
```

:::{note}
The browser receives serialized trait updates from `replace_variables` and
`update_variables`. Dependent Observable cells recompute from the updated
variables.
:::

Replace the Python-owned variables explicitly:

```python
notebook.replace_variables({"events": events[-2:]})
```

Patch the live runtime with `update_variables`:

```python
notebook.update_variables(events=events[-2:])
```

## Display One Cell

Name cells that Python needs to display or read separately from the full
notebook.

```python
notebook = obs.Notebook(
    obs.ojs('viewof gain = Inputs.range([0, 11], {value: 5})', name="gain"),
    obs.ojs("double = gain * 2", name="double"),
)

notebook.cell("gain")
notebook.value("double")
```

In marimo:

```python
import marimo as mo

mo.ui.anywidget(notebook.cell("gain"))
```

## Load Notebook Kit HTML

Use `from_file` or `from_html` for source-backed notebooks.

```python
notebook = obs.Notebook.from_file("chart.html")
```

By default, local `FileAttachment(...)` references and relative JavaScript
imports are embedded so the widget can travel with the notebook output. Use
`portable=False` when you want to keep source references as they are.

## Load a Public Observable Notebook

Use `from_url` for a public Observable notebook:

```python
notebook = obs.Notebook.from_url("https://observablehq.com/@mbostock/saving-svg")
notebook
```

The URL can be a full Observable URL, a slug such as `@mbostock/saving-svg`, or a
16-character notebook id. Remote file attachments are kept as URL-backed
attachments.

Use the same `variables` mapping to override variables in a public notebook:

```python
penguins = [
    {"culmen_length_mm": 36.7, "culmen_depth_mm": 18.4},
    {"culmen_length_mm": 44.1, "culmen_depth_mm": 15.9},
    {"culmen_length_mm": 50.2, "culmen_depth_mm": 19.1},
]
notebook = obs.Notebook.from_url(
    "https://observablehq.com/@observablehq/plot-scatterplot/2",
    variables={"penguins": penguins},
)
```
