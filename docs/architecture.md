---
title: Architecture
description: Python traits, Observable cells, browser runtime, and graph metadata.
---

# Architecture

`pyobservablejs` has one runtime boundary: Python defines notebook state, and the
browser evaluates Observable cells.

```text
Python API
  -> anywidget trait model
  -> TypeScript renderer
  -> Observable Notebook Kit runtime
  -> child cell models
  -> Python-visible values and graph metadata
```

Python prepares Notebook Kit cell specs, serializes Python values, and exposes child
widget names. TypeScript runs Notebook Kit, binds Python values as Observable
builtins, renders cell outputs, and syncs cell values plus symbolic graph
metadata back to Python.

:::{note} Runtime ownership
Notebook Kit and `@observablehq/runtime` own cell parsing, dependency analysis,
runtime variables, `viewof` semantics, and DOM output. `pyobservablejs` exposes
outputs, values, and graph metadata to Python through widget traits.
:::

## Python Package

| File                                | Role                                                                                |
| ----------------------------------- | ----------------------------------------------------------------------------------- |
| `src/pyobservablejs/_notebook.py`   | Public `Notebook`, authored cell records, runtime `NotebookCell`, and cell helpers. |
| `src/pyobservablejs/_variables.py`  | Python value serialization for `variables`.                                         |
| `src/pyobservablejs/_files.py`      | `FileAttachment` discovery and portable source rewriting.                           |
| `src/pyobservablejs/_graph.py`      | Immutable Python view of browser-produced graph metadata.                           |
| `src/pyobservablejs/_observable.py` | ObservableHQ document API specifier resolution and response conversion.             |
| `src/pyobservablejs/_serialize.py`  | Notebook Kit HTML serialization for Python-authored cells.                          |

`obs.Notebook(...)` builds a Notebook Kit `spec`, serializes `variables`, creates
one `NotebookCell` per cell, and records attachment metadata.
`obs.Notebook.from_html(...)` keeps the source HTML string and derives cell names
by reading Notebook Kit script tags.
`obs.Notebook.from_observablehq(...)` fetches
ObservableHQ's document API and converts API nodes to Notebook Kit cells.

See [](./composition.md) for the anywidget composition contract that makes those
cell widgets render inside the parent notebook and remain Python-visible widgets.

## Widget Traits

Python and TypeScript communicate through synced trait state.

| Trait           | Direction                                           | Meaning                                                      |
| --------------- | --------------------------------------------------- | ------------------------------------------------------------ |
| `source`        | Python to browser                                   | Notebook Kit HTML for source-backed notebooks.               |
| `spec`          | Python to browser                                   | Notebook Kit JSON for Python-authored notebooks.             |
| `attachments`   | Python to browser                                   | File metadata used by `FileAttachment`.                      |
| `base_url`      | Python to browser                                   | Base URL for non-embedded source references.                 |
| `_variables`    | Python to browser                                   | Serialized Python values that set or override OJS variables. |
| `_cell_widgets` | Python to browser                                   | anywidget references for child cell models.                  |
| `_graph`        | Browser to Python                                   | Notebook Kit-derived symbolic notebook graph.                |
| `_value_names`  | Browser to Python                                   | Variables exposed by a cell or notebook.                     |
| `_values`       | Browser to Python, then Python to browser for views | Latest wire values.                                          |

`_cell_widgets` uses anywidget composition. The Python trait validates real
`NotebookCell` instances, then serializes them as `anywidget:<model_id>` strings
so the browser can resolve the matching child models.

## Browser Runtime

| File or folder       | Role                                                                                |
| -------------------- | ----------------------------------------------------------------------------------- |
| `js/widget/index.ts` | anywidget entrypoint. It dispatches notebook and cell renders by model role.        |
| `js/widget/`         | Widget lifecycle, composition, DOM shell, child state, and trait synchronization.   |
| `js/runtime/`        | Observable Runtime builtins, wire values, `viewof` targets, and definition helpers. |
| `js/observable/`     | Notebook Kit `transpile` metadata and graph JSON.                                   |
| `js/model/`          | Typed anywidget trait access helpers.                                               |

Rendering follows a fixed order:

1. Read `source` or `spec` and create a Notebook Kit notebook.
2. Resolve child cell models from `_cell_widgets`.
3. Register file attachments for this widget instance.
4. Create one Notebook Kit runtime with Observable builtins and Python `variables`.
5. Transpile each cell with Notebook Kit and sync `_graph`.
6. Define cells in notebook order. The runtime resolves dependencies.
7. Mirror exposed OJS variables into child `_values` traits.
8. Aggregate child values onto the notebook model for `notebook.values`.

The full notebook is one Observable reactive graph. A standalone
`notebook.cell("name")` display creates a runtime for that child output root and
rebuilds the target cell with source-backed OJS dependencies. When sibling cells
have revivable synced values, the child runtime uses those values. Browser-only
values already defined in the parent runtime can be imported without crossing
trait JSON. This gives DOM outputs their own `canvas`, `svg`, `figure`, or
control nodes while keeping Python-visible values on the child model.

## Graph Metadata

`notebook.graph` is populated after browser render. TypeScript calls Notebook
Kit `transpile(cell, {resolveLocalImports: true})` and records:

- variables defined by each cell,
- variables referenced by each cell,
- runtime output names, including `viewof` and mutable variables,
- cell-to-cell dependency edges,
- transpilation errors reported by Notebook Kit.

This keeps the symbolic representation native to Notebook Kit. Python decodes
the synced trait into immutable `NotebookGraph`, `CellInfo`, and
`DependencyEdge` objects whose `variable` field names the dependency.

## Performance Boundaries

The main cost centers are data movement, runtime invalidation, source handling,
and browser rendering.

- `variables` crosses as JSON-compatible trait state. Dates, bytes, NumPy values,
  and dataframe records are encoded in Python and revived in TypeScript.
- Matching `variables` keys are applied with Observable Runtime `redefine`, so Python
  values can replace variables from Python-authored, source-backed, and public
  ObservableHQ notebooks.
- Matching `viewof` keys write the existing input target and dispatch its input
  event, so controls stay visually aligned with the runtime value.
- pandas and Polars series become lists before crossing the trait boundary.
  pandas and Polars dataframes become row records.
- Structural notebook updates re-render through anywidget model change events.
  Python variable updates mutate the current runtime through the synced `_variables`
  trait.
- Removing Python variable keys rebuilds the runtime, which restores the notebook's
  own definitions for those names.
- File attachments and relative imports can be embedded as data URLs. Embedding
  makes notebooks portable and increases trait/source payload size.
- Shiki is initialized once with the imported languages and theme, and falls
  back to plain source for pinned cells over `120_000` characters.
- Graph metadata is extracted during TypeScript cell transpilation and synced to
  Python through `_graph`.

:::{warning}
`update_variables` and `replace_variables` send serialized trait payloads through
traitlets. Repeated table-sized payloads can dominate notebook update time. Keep
large rows in `FileAttachment(...)` data files, or patch only the small variables
that changed.
:::

## Complexity Hotspots

Large files correspond to cross-boundary concerns.

`src/pyobservablejs/_notebook.py`
: Defines the public Python model boundary. It aligns `Notebook`, authored cells,
Python-authored cells, source-backed constructors, child anywidget composition,
trait initialization, browser-synced values, and graph state with
TypeScript-owned OJS evaluation and transpilation.

`js/widget/`
: Owns anywidget lifecycle, child widget composition, notebook rendering, and
model trait writes. `notebook-renderer.ts` creates the parent runtime,
`composed-cells.ts` binds child widgets into it, and `standalone-cell.ts`
creates the isolated output-root runtime used by direct `nb.cells[index]`
access.

`js/runtime/`
: Owns Observable Runtime mechanics that do not need widget DOM ownership.
Runtime builtins, `viewof` target mutation, wire value revival, runtime
definitions, and module import helpers live here. Model-aware variable patches
and standalone dependency selection stay under `js/widget/`.

`src/pyobservablejs/_files.py`
: Rewrites source-backed notebooks through static source analysis. It finds
`FileAttachment(...)` and relative import specifiers inside real notebook
script cells. Comments, strings, template literals, regex literals, and
non-JavaScript script types are excluded from those matches.

`src/pyobservablejs/_variables.py` and `js/runtime/wire.ts`
: Define the cross-language wire format. Tagged `__pyobservablejs_type__` values
carry dates, bytes, non-finite numbers, DOM summaries, typed arrays, and
errors across the trait boundary.

`js/widget/highlight.ts`
: Uses Shiki for pinned source panels with a selected language and theme set.
Highlighting is asynchronous and guarded by the render abort signal so stale
work exits before writing into a disposed cell.

## Portability

Source-backed notebooks can be made self-contained:

- `FileAttachment("data.csv")` becomes an attachment entry with a data URL.
- Static imports such as `import "./helper.js"` are rewritten to data URLs.
- Dynamic imports such as `import("./helper.js")` are rewritten the same way.

Public ObservableHQ notebooks are fetched through the document API. Python
serializes API nodes to Notebook Kit HTML and keeps uploaded files as remote
attachment URLs. The browser uses Notebook Kit for transpilation, runtime
execution, graph metadata, and rendering.
