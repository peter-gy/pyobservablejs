---
title: Architecture
description: How Python cells, data, anywidget traits, and the Observable runtime fit together.
---

# Architecture

The runtime flow is small but there are several moving parts:

```text
Python API
  -> anywidget trait model
  -> TypeScript widget renderer
  -> Observable Notebook Kit runtime
  -> child cell widgets
  -> Python-visible values
```

## Python Model

The Python package builds the widget model.

| File | Responsibility |
| --- | --- |
| `src/observablejs/_notebook.py` | Public `Notebook`, `Cell`, and cell helper API. |
| `src/observablejs/_graph.py` | Immutable graph dataclasses and browser-trait decoding. |
| `src/observablejs/_variables.py` | Python value serialization for `data`. |
| `src/observablejs/_files.py` | Attachment discovery and portable source rewriting. |
| `src/observablejs/_serialize.py` | Notebook Kit HTML serialization for Python-authored cells. |

`Notebook(...)` creates:

- a Notebook Kit-compatible `spec` for Python-authored cells,
- a serialized `_data` payload for Python values,
- one child cell widget per notebook cell,
- normalized attachment metadata.

`Notebook.from_file(...)` and `Notebook.from_html(...)` instead keep the original
Notebook Kit HTML in `source`, then create the same child cell handles by parsing
the HTML script cells.

## Widget Traits

The Python and TypeScript sides communicate through these traits.

| Trait | Direction | Meaning |
| --- | --- | --- |
| `source` | Python to browser | Original Notebook Kit HTML for source-backed notebooks. |
| `spec` | Python to browser | Notebook Kit JSON shape for Python-authored notebooks. |
| `attachments` | Python to browser | File metadata used by `FileAttachment`. |
| `base_url` | Python to browser | Base URL for non-embedded source references. |
| `_data` | Python to browser | Serialized Python values exposed as OJS variables. |
| `_graph` | Browser to Python | Notebook Kit-derived symbolic graph for the notebook. |
| `_cell_widgets` | Python to browser | anywidget refs for the child cell models. |
| `variable_names` | Browser to Python | Names exposed by one cell, or by the whole notebook on notebook models. |
| `variables` | Browser to Python, then Python to browser for views | Latest wire values for one cell, plus the aggregate notebook values on notebook models. |

`_cell_widgets` deliberately has a small custom list serializer around
`anywidget.WidgetTrait`. The scalar trait validates each child widget, while the
list-level serializer keeps the browser wire state as `anywidget:<model_id>` ref
strings. A bare `List(WidgetTrait())` does not apply the inner trait serializer
in the current traitlets path.

## Browser Runtime

The TypeScript package turns trait state into a running notebook.

| File | Responsibility |
| --- | --- |
| `js/widget.ts` | anywidget render function, cell composition, OJS value sync. |
| `js/runtime.ts` | Notebook Kit runtime creation and builtins. |
| `js/wire.ts` | Browser-side value serialization and Python data revival. |
| `js/attachments.ts` | FileAttachment registry scoped to each widget instance. |
| `js/types.ts` | Shared model and runtime types. |

When the notebook renders, TypeScript:

1. Reads `source` or `spec` and creates a Notebook Kit notebook.
2. Revives `_data` into runtime builtins, so OJS cells can use Python variables by
   name.
3. Registers file attachments for the widget instance.
4. Resolves the child cell widgets from `_cell_widgets`.
5. Transpiles each cell with Notebook Kit and syncs the symbolic graph to
   `_graph`.
6. Defines each OJS cell in one Notebook Kit runtime.
7. Mirrors each exposed OJS variable into the matching child widget's `variables`
   trait.
8. Aggregates child `variables` into the notebook model's own `variables` trait,
   which backs `notebook.values`.

Cell handles use anywidget v0.11 composition directly. The parent resolves each
child with `host.getWidget` / `host.getModel`, passes the parent render signal
through the child render lifecycle, and uses the child's `initialize` exports
only to hand over the shared Notebook Kit runtime context.

The graph uses Notebook Kit's `transpile(cell, {resolveLocalImports: true})`
result. It does not walk Observable runtime private fields such as `_scope`,
`_inputs`, or `_outputs`.

## Why Child Cell Widgets Exist

A full Observable notebook is one reactive graph. Python still needs handles for
individual cells.

Child widgets provide those handles without creating independent full notebooks
for every cell. The full notebook renders each cell through its child widget,
and the child widget records the values exposed by that cell. When a child is
rendered on its own, display cells run against the already-bound Notebook Kit
runtime so dependencies such as D3 selections, Mutable values, DOM nodes, and
arrays with side properties stay live JavaScript objects. `viewof` cells keep an
isolated rendering path so the standalone control can sync through the cell
model without redefining the notebook's primary view variable.

This keeps these workflows aligned:

- display the full notebook,
- display `notebook.cell("gain")`,
- read `notebook.value("gain")`,
- read reactive aggregate values with `notebook.values`,
- update a `viewof` value through synced widget state.

## Portability

For source-backed notebooks, local files can be embedded:

- `FileAttachment("data.csv")` becomes an attachment entry with a data URL.
- Relative static imports such as `import "./helper.js"` are rewritten to data
  URLs.
- Relative dynamic imports such as `import("./helper.js")` are also rewritten.

This is designed for notebooks that need to move between Python frontends without
depending on the original local file tree.
