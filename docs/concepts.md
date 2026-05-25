---
title: Concepts
description: The main ideas behind observablejs.
---

# Concepts

`observablejs` connects Python objects to the Observable notebook model. The
main pieces are Observable cells, Notebook Kit, traitlets, Python-owned OJS
variables, cell widgets, and graph metadata.

## Observable JavaScript

Observable JavaScript is a reactive notebook language for the browser. When an
input changes, dependent cells recompute.

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

`observablejs` accepts three Notebook Kit entry points:

- Python-authored cells are converted to Notebook Kit cell specs.
- Existing Notebook Kit HTML can be loaded with `Notebook.from_file` or
  `Notebook.from_html`.
- Public Observable notebooks can be fetched with `Notebook.from_url` and then
  rendered through the same Notebook Kit runtime.

## anywidget and traitlets

anywidget is the Python widget layer. It gives Python a model with synced
traitlets and gives the browser a TypeScript renderer for that model.

The trait boundary carries widget state:

- Python sets traits such as `spec`, `source`, `attachments`, and `_variables`.
- TypeScript reads those traits and creates the Observable runtime.
- TypeScript writes OJS cell outputs and metadata back to child widget traits.
- Python can inspect those child widget traits with `notebook.cell(...)` and
  `notebook.value(...)`.

## Python Variables in OJS

Python values enter OJS through `variables={...}`. The mapping sets Observable
variables and can override variables defined by Python-authored, source-backed,
or URL-backed notebooks.

```python
ojs.Notebook(
    ojs.cell("rows.length"),
    variables={"rows": [{"x": 1}, {"x": 2}]},
)
```

OJS code reads `rows` directly as a normal Observable variable. In source-backed
and public Observable notebooks, a matching `variables` key replaces the notebook's
runtime value.

For a live notebook, call `notebook.replace_variables({...})` or
`notebook.update_variables(...)` to push new Python values into the existing
Observable runtime. Ordinary variables are redefined through Observable Runtime.
For `viewof` variables, the rendered control is updated and emits the same input
event as a user interaction.

The serializer accepts JSON-like values, dates, bytes, NumPy values, and
dataframe-like objects. Dataframes become records by default. Use
`ojs.arrow(df)` when you want Arrow IPC and have `pyarrow` installed.

:::{warning}
Large values cross the Python/browser boundary as widget trait payloads. For
large tables, prefer existing `FileAttachment(...)` data files or Arrow payloads
over repeatedly assigning large record lists.
:::

## Cell Widgets

Every notebook cell has a matching child widget. Named cells provide stable
Python names:

```python
notebook.cell("gain")
notebook.cell("gain").value
notebook.values
```

`notebook.values` is synchronized on the notebook widget itself. When a `viewof`
input changes in the browser, the matching child cell trait updates first and the
notebook trait receives the aggregate values immediately after.

Separate cell displays stay connected through the shared browser-side cell model.

## Notebook Graph

Once a notebook has rendered in the browser, Python can inspect the symbolic
notebook graph:

```python
notebook.graph
notebook.graph.cells
notebook.graph.edges
notebook.cell("gain").info
notebook.cell_for_variable("gain")
```

Notebook Kit `transpile` metadata in TypeScript supplies the graph, using the
same symbolic cell metadata that defines variables in the Observable runtime.
Each cell reports:

- `defines`: Python-visible variables exposed by the cell
- `references`: variables the cell reads
- `output`: Notebook Kit's raw singular runtime output, when present
- `outputs`: Notebook Kit's raw plural output declarations
- `runtime_outputs`: raw runtime names used for dependency edges

Display expression cells can have `autodisplay=True` and an empty `defines`
list.

## Notebook Entry Points

The package has three notebook entry points:

- Python-authored notebooks: `Notebook(ojs.cell(...), ojs.md(...))`
- Source-backed notebooks: `Notebook.from_file(...)` or `Notebook.from_html(...)`
- Public Observable notebooks: `Notebook.from_url(...)`

Python-authored notebooks are serialized to Notebook Kit HTML when needed.
Source-backed notebooks keep their original Notebook Kit HTML and parse the
script cells needed for Python-visible cell widgets. URL-backed notebooks use
Observable's document API, convert API `js` cells to Notebook Kit `ojs` cells,
and register remote uploaded files as `FileAttachment` URLs.
