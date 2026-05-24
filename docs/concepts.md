---
title: Concepts
description: The main ideas behind observablejs.
---

# Concepts

`observablejs` connects Python to the Observable notebook model. These are the
pieces it relies on.

## Observable JavaScript

Observable JavaScript is a notebook language for the browser. It looks like
JavaScript, but cells are reactive: when an input changes, dependent cells
recompute.

Important OJS ideas:

- A cell can define a variable, such as `answer = 42`.
- A cell can display a value directly, such as `Plot.plot(...)`.
- `viewof name = ...` creates an interactive input and exposes its current value
  as `name`.
- Builtins such as `Plot`, `Inputs`, `FileAttachment`, `md`, and `html` come from
  the runtime library.

## Notebook Kit

Observable Notebook Kit provides the browser compiler and runtime used here. It
turns notebook cells into runtime definitions, evaluates them in dependency
order, and renders outputs into DOM nodes.

`observablejs` uses Notebook Kit in two ways:

- Python-authored cells are converted to Notebook Kit cell specs.
- Existing Notebook Kit HTML can be loaded with `Notebook.from_file` or
  `Notebook.from_html`.

## anywidget And traitlets

anywidget is the Python widget layer. It gives Python a model with synced
traitlets and gives the browser a TypeScript renderer for that model.

The important boundary is trait state:

- Python sets traits such as `spec`, `source`, `attachments`, and `_data`.
- TypeScript reads those traits and creates the Observable runtime.
- TypeScript writes OJS cell values back to child widget traits.
- Python can inspect those child widget traits with `notebook.cell(...)` and
  `notebook.value(...)`.

## Python Data In OJS

Python data enters OJS through `data={...}`.

```python
ojs.Notebook(
    ojs.cell("rows.length"),
    data={"rows": [{"x": 1}, {"x": 2}]},
)
```

The browser sees `rows` as a normal Observable variable. There is no special
syntax inside OJS.

The data serializer handles JSON-like values, dates, bytes, NumPy values, and
dataframe-like objects. Dataframes become records by default. Use `ojs.arrow(df)`
when you want Arrow IPC and have `pyarrow` installed.

## Cell Handles

Every notebook cell has a matching child widget. Named cells are useful because
they provide stable Python handles:

```python
notebook.cell("gain")
notebook.cell("gain").value
notebook.values
```

`notebook.values` is synchronized on the notebook widget itself. When a `viewof`
input changes in the browser, the matching child cell trait updates first and the
notebook trait receives the aggregate values immediately after.

This is what makes it possible to render a control cell separately from the full
notebook while still keeping it connected to the same OJS computation.

## Notebook Graph

Once a notebook has rendered in the browser, Python can inspect the symbolic
notebook graph:

```python
notebook.graph
notebook.graph.cells
notebook.graph.edges
notebook.cell("gain").info
notebook.defining_cell("gain")
```

This graph is not parsed in Python. It comes from Notebook Kit's `transpile`
metadata on the TypeScript side, the same metadata used to define cells in the
Observable runtime. Each cell reports:

- `defines`: Python-visible variables exposed by the cell
- `references`: variables the cell reads
- `output`: Notebook Kit's raw singular runtime output, when present
- `outputs`: Notebook Kit's raw plural output declarations
- `runtime_outputs`: raw runtime names used for dependency edges

Expression-only display cells can have `autodisplay=True` while defining no
variable.

## Source-backed Versus Python-authored

There are two notebook entry points:

- Python-authored notebooks: `Notebook(ojs.cell(...), ojs.md(...))`
- Source-backed notebooks: `Notebook.from_file(...)` or `Notebook.from_html(...)`

Python-authored notebooks are serialized to Notebook Kit HTML when needed.
Source-backed notebooks keep their original Notebook Kit HTML and parse it only
enough to create Python-visible cell handles.
