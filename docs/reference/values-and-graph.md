---
title: Values and graph
description: NotebookCell readback, CellValues records, render gates, and NotebookGraph metadata.
---

# Values and graph

The browser synchronizes rendered values and symbolic dependency metadata to
Python. Value readback and graph readback have separate lifecycle gates.

```python
cell = notebook.cell_by_key("gain_control")

if cell.has_rendered:
    gain = cell.value("gain")

if notebook.has_graph_snapshot:
    dependencies = notebook.graph
```

## `NotebookCell`

`NotebookCell` is a child widget owned by a `Notebook`. Retrieve instances
through `notebook.cells`, `notebook.cell_at`, `notebook.cell_by_key`, or
`notebook.cell_for_variable`.

### Attributes

| Attribute         | Type              | Contract                                                                  |
| ----------------- | ----------------- | ------------------------------------------------------------------------- |
| `key`             | `str`             | Python cell handle, or `""` when the authored cell has no key.            |
| `name`            | `str`             | Notebook Kit cell name, or `""` when the source has no name.              |
| `has_rendered`    | `bool`            | Whether this child widget has synchronized a browser output.              |
| `info`            | `CellInfo`        | Graph metadata for this cell. Requires a graph snapshot.                  |
| `defines`         | `tuple[str, ...]` | Variables defined by the cell, delegated from `info`.                     |
| `references`      | `tuple[str, ...]` | Variables read by the cell, delegated from `info`.                        |
| `outputs`         | `tuple[str, ...]` | Notebook Kit output names, delegated from `info`.                         |
| `runtime_outputs` | `tuple[str, ...]` | Raw runtime output names used for dependency edges.                       |
| `output`          | `Optional[str]`   | Primary Notebook Kit output name.                                         |
| `values`          | `dict[str, Any]`  | Latest decoded values synchronized for this cell. Requires a cell render. |

### `NotebookCell.value(name)`

```python
value = cell.value("gain")
```

Returns the decoded synchronized value for `name`. It raises
`NotRenderedError` before this cell renders and `KeyError` when the rendered
cell has no synchronized value with that name.

### `NotebookCell.only_value()`

```python
value = cell.only_value()
```

Returns the single value in `cell.values`. It raises `NotRenderedError` before
this cell renders. It raises `KeyError` when the cell has zero values or more
than one value.

## `CellValues`

```python
obs.CellValues(index, key, values)
```

`Notebook.cell_values()` returns one `CellValues` record per cell in notebook
order.

| Field    | Type             | Contract                                                |
| -------- | ---------------- | ------------------------------------------------------- |
| `index`  | `int`            | Zero-based position in the notebook.                    |
| `key`    | `Optional[str]`  | Python cell handle, or `None` when the cell has no key. |
| `values` | `dict[str, Any]` | Decoded browser-synchronized values for the cell.       |

The data class is frozen. Its `values` field is a regular dictionary returned
for that snapshot.

```python
for cell_values in notebook.cell_values():
    print(cell_values.index, cell_values.key, cell_values.values)
```

## `NotRenderedError`

```python
obs.NotRenderedError(message)
```

`NotRenderedError` is a `RuntimeError` raised when a readback member is accessed
before the browser has synchronized the state that member requires.

| Readback member                                                                      | Required state                                       |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `Notebook.runtime_values`, `Notebook.cell_values()`, `Notebook.value(name)`          | Full notebook render                                 |
| `Notebook.graph`, `Notebook.cell_for_variable(name)`                                 | Graph snapshot from a notebook or direct cell render |
| `NotebookCell.values`, `NotebookCell.value(name)`, `NotebookCell.only_value()`       | Render of that child cell                            |
| `NotebookCell.info`, `defines`, `references`, `outputs`, `runtime_outputs`, `output` | Parent graph snapshot containing that cell           |

Displaying one `NotebookCell` can set `cell.has_rendered` and
`notebook.has_graph_snapshot` while `notebook.has_rendered` remains false. In
that state, cell values and graph metadata are available, while notebook-level
value readback raises `NotRenderedError`.

## `NotebookGraph`

```python
obs.NotebookGraph(cells, edges)
```

`notebook.graph` returns a frozen `NotebookGraph` after graph metadata syncs.
The browser may produce the snapshot during a full notebook render or a direct
`NotebookCell` render. Malformed browser entries are dropped while Python
decodes the graph trait.

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
if notebook.has_graph_snapshot:
    graph = notebook.graph
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
