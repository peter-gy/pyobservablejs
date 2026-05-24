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

Use `ojs.Notebook` with cell helpers. `ojs.cell` is Observable JavaScript by
default.

```python
import observablejs as ojs

notebook = ojs.Notebook(
    ojs.md("# A small notebook"),
    ojs.cell("answer = 40 + 2", name="answer"),
    ojs.cell("md`The answer is **${answer}**.`"),
)

notebook
```

In a notebook frontend, displaying `notebook` renders the full Observable
notebook.

## Pass Python Data

Pass a mapping with `data`. Keys must be JavaScript identifiers because they
become variable names inside OJS.

```python
import observablejs as ojs

events = [
    {"day": "Mon", "value": 12},
    {"day": "Tue", "value": 18},
    {"day": "Wed", "value": 15},
]

ojs.Notebook(
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

Update the data by assigning to `notebook.data`:

```python
notebook.data = {"events": events[-2:]}
```

## Display One Cell

Name a cell when Python should address it later.

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

By default, local `FileAttachment(...)` references and relative JavaScript imports
are embedded so the widget can travel with the notebook output. Use
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
