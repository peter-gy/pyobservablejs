---
title: Concepts
description: The main ideas behind pyobservablejs.
---

# Concepts

Python creates `obs.Notebook`, anywidget sends notebook traits to the browser,
Notebook Kit evaluates Observable cells, and Python reads synchronized values
from widget traits.

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

`pyobservablejs` accepts three Notebook Kit entry points:

- Python-authored cells are converted to Notebook Kit cell specs.
- Existing Notebook Kit HTML strings can be loaded with `obs.Notebook.from_html`.
- Public ObservableHQ notebooks can be fetched with
  `obs.Notebook.from_observablehq` and then rendered through the same Notebook
  Kit runtime.

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
or ObservableHQ-backed notebooks.

```python
obs.Notebook(
    obs.ojs("rows.length"),
    variables={"rows": [{"x": 1}, {"x": 2}]},
)
```

OJS code reads `rows` directly as a normal Observable variable. In source-backed
and public ObservableHQ notebooks, a matching `variables` key replaces the
notebook's runtime value.

For a live notebook, call `notebook.replace_variables({...})` or
`notebook.update_variables(...)` to push new Python values into the existing
Observable runtime. Ordinary variables are redefined through Observable Runtime.
For `viewof` variables, the rendered control is updated and emits the same input
event as a user interaction.

The serializer accepts JSON-like values, dates, bytes, NumPy values, pandas or
Polars series, and pandas or Polars dataframes. Series become lists. Dataframes
become row records.

:::{warning}
Each `update_variables` or `replace_variables` call resends serialized trait
payloads for the affected Python-owned values. For repeated table updates, keep
the data in a file attachment and pass small control values through `variables`.

```python
obs.Notebook(
    obs.ojs('rows = FileAttachment("rows.json").json()'),
    attachments={"rows.json": "rows.json"},
)
```

:::

## Cell Widgets

Every notebook cell has a matching child widget. Named cells provide stable
Python names:

```python
gain = notebook.cell("gain")
gain.value
notebook.values
```

`notebook.values` is synchronized on the notebook widget itself. When a `viewof`
input changes in the browser, the matching child cell trait updates first and the
notebook trait receives the aggregate values immediately after. `NotebookCell`
handles expose the same synchronized values and graph metadata for their
matching cells.

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

Notebook Kit `transpile` metadata in TypeScript supplies the graph. Python uses
it to select cells by variable name and to inspect dependency edges. See
[](./api.md#graph-metadata) for `CellInfo` fields and graph lookup methods.

## Notebook Entry Points

The package has three notebook entry points:

- Python-authored notebooks: `obs.Notebook(obs.ojs(...), obs.md(...))`
- Source-backed notebooks: `obs.Notebook.from_html(...)`
- Public ObservableHQ notebooks: `obs.Notebook.from_observablehq(...)`

Python-authored notebooks are serialized to Notebook Kit HTML when needed.
Source-backed notebooks keep their original Notebook Kit HTML and parse the
script cells needed for Python-visible cell widgets. ObservableHQ notebooks use
the document API, convert API `js` cells to Notebook Kit `ojs` cells, and
register remote uploaded files as `FileAttachment` URLs.
