---
title: Quickstart
description: Install observablejs and create a small notebook from Python.
---

# Quickstart

## Install

```sh
pip install observablejs
```

or with `uv`:

```sh
uv add observablejs
```

For dataframe and Arrow helpers:

```sh
uv add "observablejs[data]"
```

## Create a Notebook

Use `ojs.Notebook` with cell helpers. `ojs.cell` creates an Observable
JavaScript cell.

```python
import observablejs as ojs

notebook = ojs.Notebook(
    ojs.md("# A small notebook"),
    ojs.cell("answer = 40 + 2", name="answer"),
    ojs.cell("md`The answer is **${answer}**.`"),
)

notebook
```

Displaying `notebook` renders the full Observable notebook in any compatible
widget frontend.

## Pass Python Values

Pass a mapping with `data`. Each key becomes an OJS variable name, so keys must
be JavaScript identifiers. If a notebook defines the same variable, the Python
value overrides that definition.

```python
import observablejs as ojs

events = [
    {"day": "Mon", "value": 12},
    {"day": "Tue", "value": 18},
    {"day": "Wed", "value": 15},
]

notebook = ojs.Notebook(
    ojs.cell("""
    Plot.plot({
      height: 220,
      y: {grid: true},
      marks: [Plot.lineY(events, {x: "day", y: "value", marker: true})]
    })
    """),
    data={"events": events},
)
```

:::{note}
The browser receives a serialized trait payload for each `notebook.data`
assignment. Dependent Observable cells recompute from the updated variables.
:::

Update the data by assigning to `notebook.data`:

```python
notebook.data = {"events": events[-2:]}
```

## Display One Cell

Name cells that Python needs to display or read separately from the full
notebook.

```python
notebook = ojs.Notebook(
    ojs.cell('viewof gain = Inputs.range([0, 11], {value: 5})', name="gain"),
    ojs.cell("gain * 2", name="double"),
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
notebook = ojs.Notebook.from_file("chart.html")
```

By default, local `FileAttachment(...)` references and relative JavaScript
imports are embedded so the widget can travel with the notebook output. Use
`portable=False` when you want to keep source references as they are.

## Load a Public Observable Notebook

Use `from_url` for a public Observable notebook:

```python
notebook = ojs.Notebook.from_url("https://observablehq.com/@mbostock/saving-svg")
notebook
```

The URL can be a full Observable URL, a slug such as `@mbostock/saving-svg`, or a
16-character notebook id. Remote file attachments are kept as URL-backed
attachments.

Use the same `data` mapping to override variables in a public notebook:

```python
penguins = [
    {"culmen_length_mm": 36.7, "culmen_depth_mm": 18.4},
    {"culmen_length_mm": 44.1, "culmen_depth_mm": 15.9},
    {"culmen_length_mm": 50.2, "culmen_depth_mm": 19.1},
]
notebook = ojs.Notebook.from_url(
    "https://observablehq.com/@observablehq/plot-scatterplot/2",
    data={"penguins": penguins},
)
```
