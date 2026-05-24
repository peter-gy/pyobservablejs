---
title: Architecture
description: Python traits, Observable cells, browser runtime, and graph metadata.
---

# Architecture

`observablejs` has one runtime boundary: Python defines notebook state, and the
browser evaluates Observable cells.

```text
Python API
  -> anywidget trait model
  -> TypeScript renderer
  -> Observable Notebook Kit runtime
  -> child cell models
  -> Python-visible values and graph metadata
```

Python prepares Notebook Kit inputs, serializes Python values, and exposes child
widget handles. TypeScript runs Notebook Kit, binds Python values as Observable
builtins, renders cell outputs, and syncs cell values plus symbolic graph
metadata back to Python.

:::{note} Runtime ownership
Notebook Kit and `@observablehq/runtime` own cell parsing, dependency analysis,
runtime variables, `viewof` semantics, and DOM output. `observablejs` keeps those
results visible to Python through widget traits.
:::

## Python Package

| File | Role |
| --- | --- |
| `src/observablejs/_notebook.py` | Public `Notebook`, `Cell`, `CellHandle`, and cell helpers. |
| `src/observablejs/_variables.py` | Python value serialization for `data`. |
| `src/observablejs/_files.py` | `FileAttachment` discovery and portable source rewriting. |
| `src/observablejs/_graph.py` | Immutable Python view of browser-produced graph metadata. |
| `src/observablejs/_observable.py` | Observable document API URL resolution and response conversion. |
| `src/observablejs/_serialize.py` | Notebook Kit HTML serialization for Python-authored cells. |

`Notebook(...)` builds a Notebook Kit `spec`, serializes `data`, creates one
`CellHandle` per cell, and records attachment metadata. `Notebook.from_file(...)`
and `Notebook.from_html(...)` keep the source HTML and derive the same cell
handles by reading Notebook Kit script tags. `Notebook.from_url(...)` fetches
Observable's document API and converts API nodes to Notebook Kit cells.

See [](./composition.md) for the anywidget composition contract that makes those
cell handles render inside the parent notebook and remain Python-visible widgets.

## Widget Traits

Python and TypeScript communicate through synced trait state.

| Trait | Direction | Meaning |
| --- | --- | --- |
| `source` | Python to browser | Notebook Kit HTML for source-backed notebooks. |
| `spec` | Python to browser | Notebook Kit JSON for Python-authored notebooks. |
| `attachments` | Python to browser | File metadata used by `FileAttachment`. |
| `base_url` | Python to browser | Base URL for non-embedded source references. |
| `_data` | Python to browser | Serialized Python values that set or override OJS variables. |
| `_cell_widgets` | Python to browser | anywidget references for child cell models. |
| `_graph` | Browser to Python | Notebook Kit-derived symbolic notebook graph. |
| `variable_names` | Browser to Python | Variables exposed by a cell or notebook. |
| `variables` | Browser to Python, then Python to browser for views | Latest wire values. |

`_cell_widgets` uses anywidget composition. The Python trait validates real
`CellHandle` instances, then serializes them as `anywidget:<model_id>` strings
so the browser can resolve the matching child models.

## Browser Runtime

| File | Role |
| --- | --- |
| `js/widget.ts` | anywidget lifecycle, Notebook Kit runtime binding, cell composition, value sync. |
| `js/runtime.ts` | Runtime builtins, `FileAttachment`, `width`, and Python data variables. |
| `js/wire.ts` | Browser-side value serialization and Python data revival. |
| `js/graph.ts` | Notebook Kit `transpile` metadata to notebook graph JSON. |
| `js/attachments.ts` | Scoped `FileAttachment` registry cleanup. |
| `js/highlight.ts` | Shiki-backed rendering for pinned source cells. |

Rendering follows a fixed order:

1. Read `source` or `spec` and create a Notebook Kit notebook.
2. Resolve child cell models from `_cell_widgets`.
3. Register file attachments for this widget instance.
4. Create one Notebook Kit runtime with Observable builtins and Python `data`.
5. Transpile each cell with Notebook Kit and sync `_graph`.
6. Define cells in notebook order. The runtime resolves dependencies.
7. Mirror exposed OJS variables into child `variables` traits.
8. Aggregate child values onto the notebook model for `notebook.values`.

The full notebook is one Observable reactive graph. A standalone
`notebook.cell("name")` display for an ordinary cell renders against the bound
parent runtime. `viewof` cells use an isolated render path with a separate DOM
target and a synchronized current value on the cell model.

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
`DependencyEdge` objects.

## Performance Boundaries

The main cost centers are data movement, runtime invalidation, source handling,
and browser rendering.

- `data` crosses as JSON-compatible trait state. Dates, bytes, NumPy values, and
  dataframe records are encoded in Python and revived in TypeScript.
- Matching `data` keys are applied with Observable Runtime `redefine`, so Python
  values can replace variables from Python-authored, source-backed, and public
  Observable notebooks.
- `ojs.arrow(df)` sends Arrow IPC and lazily imports Apache Arrow in the browser.
- Notebook updates re-render through anywidget model change events. The render
  path aborts obsolete work before starting the next runtime.
- File attachments and relative imports can be embedded as data URLs. Embedding
  makes notebooks portable and increases trait/source payload size.
- Shiki is initialized once with the imported languages and theme, and falls
  back to plain source for very large pinned cells.
- Graph metadata is extracted during TypeScript cell transpilation and synced to
  Python through `_graph`.

:::{warning}
Traitlets are a control and state channel for complete payload updates.
Frequent reassignment of large `data` payloads will dominate notebook update
time.
:::

## Complexity Hotspots

Large files correspond to cross-boundary concerns.

`src/observablejs/_notebook.py`
: Defines the public Python model boundary. It aligns `Notebook`, `CellHandle`,
  Python-authored cells, source-backed constructors, child anywidget composition,
  trait initialization, browser-synced values, and graph state with
  TypeScript-owned OJS evaluation and transpilation.

`js/widget.ts`
: Coordinates anywidget lifecycle, child widget composition, Notebook Kit runtime
  binding, standalone cell display, `viewof` synchronization, and abort cleanup.
  The core invariant is one parent runtime per displayed notebook, with child
  models acting as handles into that runtime.

`src/observablejs/_files.py`
: Rewrites source-backed notebooks through static source analysis. It finds
  `FileAttachment(...)` and relative import specifiers inside real notebook
  script cells. Comments, strings, template literals, regex literals, and
  non-JavaScript script types are excluded from those matches.

`src/observablejs/_variables.py` and `js/wire.ts`
: Define the cross-language wire format. Tagged `__observablejs_type__` values
  carry dates, bytes, non-finite numbers, Arrow tables, DOM summaries, typed
  arrays, and errors across the trait boundary.

`js/highlight.ts`
: Uses Shiki for pinned source panels with a selected language and theme set.
  Highlighting is asynchronous and guarded by the render abort signal so stale
  work exits before writing into a disposed cell.

## Portability

Source-backed notebooks can be made self-contained:

- `FileAttachment("data.csv")` becomes an attachment entry with a data URL.
- Static imports such as `import "./helper.js"` are rewritten to data URLs.
- Dynamic imports such as `import("./helper.js")` are rewritten the same way.

Public Observable URLs are fetched through the document API. Python serializes
API nodes to Notebook Kit HTML and keeps uploaded files as remote attachment
URLs. The browser uses Notebook Kit for transpilation, runtime execution, graph
metadata, and rendering.
