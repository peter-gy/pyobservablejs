---
title: Values and graph
description: NotebookCell values and NotebookGraph metadata.
---

# Values and graph

The browser synchronizes values and graph metadata back to Python after the
notebook renders.

```python
cell = notebook.cell_by_key("gain_control")
cell.value("gain")
cell.values
notebook.runtime_values
notebook.cell_values()
notebook.value("double")
notebook.graph
```

## `NotebookCell`

`NotebookCell` is a child widget owned by the parent `Notebook`. It exposes:

| Attribute         | Behavior                                        |
| ----------------- | ----------------------------------------------- |
| `key`             | Python cell handle                              |
| `name`            | Notebook Kit cell name                          |
| `info`            | `CellInfo` after graph sync                     |
| `defines`         | Variables defined by the cell                   |
| `references`      | Variables read by the cell                      |
| `outputs`         | Notebook Kit output names                       |
| `runtime_outputs` | Runtime output names used for edges             |
| `output`          | Primary Notebook Kit output name                |
| `values`          | Decoded synchronized values                     |
| `value(name)`     | Decoded synchronized value for `name`           |
| `only_value()`    | The only decoded value, when exactly one exists |

Before render, `values`, `value(name)`, `only_value()`, and `info` raise
`NotRenderedError`. After render, `value(name)` raises `KeyError` when `name`
has not synchronized. `only_value()` raises `KeyError` when no value has
synchronized or when the cell exposes more than one value.

## `NotebookGraph`

`notebook.graph` raises `NotRenderedError` before render. After graph sync, it
returns an immutable `NotebookGraph` with `cells` and `edges`. Malformed browser
entries are dropped while decoding the synced graph trait.

```python
if notebook.has_rendered:
    graph = notebook.graph
    graph.defines
    graph.references
    graph.external_references
    graph.cell(0)
    graph.cell_for_variable("double")
```

| Attribute             | Behavior                                                 |
| --------------------- | -------------------------------------------------------- |
| `cells`               | Tuple of `CellInfo` records                              |
| `edges`               | Tuple of `DependencyEdge` records                        |
| `defines`             | Unique variables defined by decoded cells                |
| `references`          | Unique variables referenced by decoded cells             |
| `external_references` | Referenced names not defined by cells or runtime outputs |

| Method                          | Behavior                                        |
| ------------------------------- | ----------------------------------------------- |
| `graph.cell(index)`             | Returns `CellInfo` for the cell index or `None` |
| `graph.cell_for_variable(name)` | Returns the unique cell that defines `name`     |

`graph.cell_for_variable(name)` raises `KeyError` when the variable is missing or
ambiguous.

## `CellInfo`

`CellInfo` describes one rendered notebook cell.

| Field             | Behavior                                         |
| ----------------- | ------------------------------------------------ |
| `id`              | Notebook Kit cell id                             |
| `index`           | Zero-based cell position                         |
| `mode`            | Cell mode such as `ojs`, `js`, `md`, or `html`   |
| `key`             | Python cell handle or `None`                     |
| `name`            | Notebook Kit cell name or `None`                 |
| `defines`         | Variables defined by the cell                    |
| `references`      | Variables read by the cell                       |
| `output`          | Primary Notebook Kit output name or `None`       |
| `outputs`         | Notebook Kit output names                        |
| `runtime_outputs` | Runtime output names used for dependency edges   |
| `autodisplay`     | Whether Notebook Kit auto-displays the output    |
| `autoview`        | Whether Notebook Kit generated a `viewof` output |
| `automutable`     | Whether Notebook Kit generated a mutable output  |
| `error`           | Graph-level error text or `None`                 |

## `DependencyEdge`

`DependencyEdge` describes one symbolic dependency between two cells.

| Field       | Behavior                                 |
| ----------- | ---------------------------------------- |
| `source_id` | Id of the cell that defines the variable |
| `target_id` | Id of the cell that reads the variable   |
| `variable`  | Variable name that links the cells       |
