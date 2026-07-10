---
title: Reference
description: Public Python API reference for pyobservablejs.
---

# Reference

The `observablejs` package exports 13 public names for authoring notebooks,
reading browser-synchronized values, and inspecting dependency graphs.

```python
import observablejs as obs

notebook = obs.Notebook(
    obs.md("# Summary"),
    obs.ojs("answer = 40 + 2", key="answer"),
)
```

## Public exports

| Export                                                     | Kind              | Contract                                                                                                |
| ---------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------- |
| [`Notebook`](notebook.md)                                  | Class             | Owns Notebook Kit source, widget state, file attachments, variables, child cells, and browser readback. |
| [`Cell`](cells.md#cell)                                    | Frozen data class | Describes one Python-authored Notebook Kit cell.                                                        |
| [`ojs`](cells.md#cell-helpers)                             | Function          | Creates an Observable JavaScript `Cell`.                                                                |
| [`js`](cells.md#cell-helpers)                              | Function          | Creates a JavaScript module `Cell`.                                                                     |
| [`md`](cells.md#cell-helpers)                              | Function          | Creates a Markdown `Cell`.                                                                              |
| [`html`](cells.md#cell-helpers)                            | Function          | Creates an HTML `Cell`.                                                                                 |
| [`NotebookCell`](values-and-graph.md#notebookcell)         | Class             | Exposes one notebook cell as a child widget with cell-level values and graph metadata.                  |
| [`CellValues`](values-and-graph.md#cellvalues)             | Frozen data class | Carries the synchronized values for one cell in notebook order.                                         |
| [`NotebookGraph`](values-and-graph.md#notebookgraph)       | Frozen data class | Contains decoded cells and symbolic dependency edges.                                                   |
| [`CellInfo`](values-and-graph.md#cellinfo)                 | Frozen data class | Describes one cell in a synchronized graph snapshot.                                                    |
| [`DependencyEdge`](values-and-graph.md#dependencyedge)     | Frozen data class | Describes one variable dependency between two cells.                                                    |
| [`NotRenderedError`](values-and-graph.md#notrenderederror) | Exception         | Reports that browser-synchronized state is being read before its render gate.                           |
| [`NOTEBOOK_THEMES`](notebook-themes.md)                    | Tuple             | Lists the accepted Notebook Kit theme names.                                                            |

The reference pages cover these related entry points:

- [Variables](variables.md) defines both directions of value serialization and
  the variable update lifecycle.
- [File attachments](file-attachments.md) defines `files`, `base_path`, and
  `FileAttachment` resolution.
- [Source notebooks](source-notebooks.md) defines the `Notebook.from_*`
  constructors.
