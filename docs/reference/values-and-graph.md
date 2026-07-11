---
title: Values and graph
description: NotebookView readback, CellValues records, render gates, and NotebookGraph metadata.
---

# Values and graph

`NotebookView` synchronizes rendered values and symbolic dependency metadata to
Python. Readback belongs to the view whose browser runtime produced it.

```python
full_view = notebook.view()

if full_view.has_rendered:
    gain = full_view.value("gain")

if full_view.has_graph_snapshot:
    dependencies = full_view.graph
```

## `NotebookView`

A view can cover the complete notebook, one selected cell, or a composite
selection.

```python
full_view = notebook.view()
gain_view = notebook.cell_by_key("gain_control").view()
summary_view = notebook.view(cells=[0, 1])
```

Views from one notebook share named Python variables. An interaction with a
named `viewof` input is shared with current and future views. Untouched source
defaults remain local to each runtime. Each view owns its runtime values,
per-cell values, graph, and render gates. Its graph contains the selected cells
and the dependency closure evaluated by that view. `cell_values()` contains the
selected cells.

### Readback members

| Member               | Type                     | Contract                                                       |
| -------------------- | ------------------------ | -------------------------------------------------------------- |
| `has_rendered`       | `bool`                   | Whether this view has synchronized a completed browser render. |
| `has_graph_snapshot` | `bool`                   | Whether this view has synchronized graph metadata.             |
| `runtime_values`     | `dict[str, Any]`         | Decoded values with one owning cell in this view.              |
| `cell_values()`      | `tuple[CellValues, ...]` | Per-cell decoded values in this view's logical cell order.     |
| `value(name)`        | `Any`                    | One entry from `runtime_values`.                               |
| `graph`              | `NotebookGraph`          | Static dependency graph for cells evaluated by this view.      |

`runtime_values`, `cell_values()`, and `value(name)` require a completed view
render. `graph` requires a graph snapshot. `value(name)` raises `KeyError` when
the rendered value mapping has no matching name. A name produced by multiple
selected cells is omitted from `runtime_values` because it has no unique owner.

## `NotebookCell`

`NotebookCell` is a cached selection handle for one cell in a `Notebook`.
Retrieve handles through `notebook.cells`, `notebook.cell_at`, or
`notebook.cell_by_key`. Call `view()` to create a renderable view for that cell
and its dependencies.

```python
cell = notebook.cell_by_key("gain_control")
gain_view = cell.view()
```

The handle exposes its `key` and Notebook Kit `name`. Browser values and graph
metadata belong to `gain_view`.

## `CellValues`

```python
obs.CellValues(index, key, values)
```

`NotebookView.cell_values()` returns one `CellValues` record per logical cell
in the view.

| Field    | Type             | Contract                                                |
| -------- | ---------------- | ------------------------------------------------------- |
| `index`  | `int`            | Zero-based position in the notebook.                    |
| `key`    | `Optional[str]`  | Python cell handle, or `None` when the cell has no key. |
| `values` | `dict[str, Any]` | Decoded browser-synchronized values for the cell.       |

The data class is frozen. Its `values` field is a regular dictionary returned
for that snapshot.

```python
for cell_values in full_view.cell_values():
    print(cell_values.index, cell_values.key, cell_values.values)
```

## `NotRenderedError`

```python
obs.NotRenderedError(message)
```

`NotRenderedError` is a `RuntimeError` raised when code reads synchronized state
before the browser has produced the required snapshot.

| Readback member                                                   | Required state        |
| ----------------------------------------------------------------- | --------------------- |
| `NotebookView.runtime_values`, `cell_values()`, and `value(name)` | Completed view render |
| `NotebookView.graph`                                              | View graph snapshot   |

The gates are view-local. Rendering `full_view` leaves a newly created
`summary_view` unreadable until `summary_view` renders.

## `NotebookGraph`

```python
obs.NotebookGraph(cells, edges)
```

`NotebookView.graph` returns a frozen `NotebookGraph` after graph metadata
synchronizes. Malformed browser entries are dropped while Python decodes the
graph trait.

### Attributes

| Attribute             | Type                         | Contract                                                           |
| --------------------- | ---------------------------- | ------------------------------------------------------------------ |
| `cells`               | `tuple[CellInfo, ...]`       | Decoded cell records.                                              |
| `edges`               | `tuple[DependencyEdge, ...]` | Decoded edges whose source and target ids exist in `cells`.        |
| `defines`             | `tuple[str, ...]`            | Unique defined names in cell order.                                |
| `references`          | `tuple[str, ...]`            | Unique referenced names in cell order.                             |
| `external_references` | `tuple[str, ...]`            | Referenced names absent from cell definitions and runtime outputs. |

### `NotebookGraph.cell(index)`

Returns the `CellInfo` whose `index` equals `index`, or `None` when the graph
has no matching cell.

### `NotebookGraph.cell_for_variable(variable)`

Returns the unique `CellInfo` that defines `variable`. It raises `KeyError`
when no cell defines the variable or multiple cells define it.

### `NotebookGraph.to_mermaid()`

Returns a Mermaid `flowchart LR` string for cell and external dependencies.

### `NotebookGraph.to_d2()`

Returns a D2 diagram string with `direction: right`.

```python
if full_view.has_graph_snapshot:
    graph = full_view.graph
    print(graph.to_mermaid())
```

## `CellInfo`

```python
obs.CellInfo(
    id,
    index,
    mode,
    key,
    name,
    defines,
    references,
    output,
    outputs,
    runtime_outputs,
    autodisplay,
    autoview,
    automutable,
    error=None,
)
```

`CellInfo` is a frozen record for one cell in a graph snapshot.

| Field             | Type              | Contract                                             |
| ----------------- | ----------------- | ---------------------------------------------------- |
| `id`              | `int`             | Notebook Kit cell id.                                |
| `index`           | `int`             | Zero-based cell position.                            |
| `mode`            | `str`             | Cell mode such as `ojs`, `js`, `md`, or `html`.      |
| `key`             | `Optional[str]`   | Python cell handle.                                  |
| `name`            | `Optional[str]`   | Notebook Kit cell name.                              |
| `defines`         | `tuple[str, ...]` | Variables defined by the cell.                       |
| `references`      | `tuple[str, ...]` | Variables read by the cell.                          |
| `output`          | `Optional[str]`   | Primary Notebook Kit output name.                    |
| `outputs`         | `tuple[str, ...]` | Notebook Kit output names.                           |
| `runtime_outputs` | `tuple[str, ...]` | Raw runtime output names used for edges.             |
| `autodisplay`     | `bool`            | Whether Notebook Kit auto-displays the output.       |
| `autoview`        | `bool`            | Whether Notebook Kit generated a `viewof` output.    |
| `automutable`     | `bool`            | Whether Notebook Kit generated a mutable output.     |
| `error`           | `Optional[str]`   | Graph-level error text when the browser reports one. |

## `DependencyEdge`

```python
obs.DependencyEdge(source_id, target_id, variable)
```

`DependencyEdge` is a frozen record for one symbolic variable dependency.

| Field       | Type  | Contract                                  |
| ----------- | ----- | ----------------------------------------- |
| `source_id` | `int` | Id of the cell that defines the variable. |
| `target_id` | `int` | Id of the cell that reads the variable.   |
| `variable`  | `str` | Variable name that links the cells.       |
