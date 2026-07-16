# Architecture

`pyobservablejs` is browser-first. Python owns notebook definitions,
serialization, attachments, and session state. The browser evaluates
Observable JavaScript through Notebook Kit. A `NotebookView` owns each browser
runtime and its synchronized readback.

The installed wheel includes the browser runtime used by Jupyter and marimo.

See [View composition](view-composition.md) for the selection, model-resolution,
synchronization, readback, and teardown paths behind `NotebookView`.

```text
Python Notebook
  definition, attachments, options, shared variables and named inputs
        |
        +---- NotebookCell selection handle
        |          |
        |          +---- view()
        |
        +---- view() or view(cells=[...])
                   |
                   v
             NotebookView model
               cell selection
                   |
                   v
          one Notebook Kit runtime
                   |
                   v
       view-owned values and graph snapshot
```

## Ownership boundaries

`Notebook` owns the definition and session. Its state includes authored cells
or source HTML, attachments, renderer options, Python variables, and named
browser input values whose serialized shapes can be shared across views.

`NotebookCell` owns a stable cell selection. `NotebookCell.view()` creates a
`NotebookView` for the selected cell and its dependency closure. The resulting
view owns the browser runtime and readback state.

`NotebookView` owns one anywidget display model, one Notebook Kit runtime, the
selected cell indices, render gates, runtime values, per-cell values, and graph
metadata. `Notebook.view()` selects every cell. `Notebook.view(cells=[...])`
creates a composite selection that evaluates in one runtime.

Separate views from one notebook share named Python variables. A browser input
event on a named `viewof` value becomes session state for current and future
views when the serialized value is writable across runtimes. Untouched source
defaults and unsupported interaction values remain local to each runtime. Use a
composite view when multiple cells require the same runtime and graph snapshot.

## Render lifecycle

1. Python creates a `Notebook` from authored cells, Notebook Kit HTML, or an
   ObservableHQ document.
2. Python creates a `NotebookView` with a full, single-cell, or composite
   selection.
3. Jupyter displays the view, or marimo wraps that view with
   `mo.ui.anywidget`.
4. The frontend resolves the referenced notebook session and reads its source,
   spec, runtime profile, attachments, variables, options, and shared input
   values.
5. Notebook Kit parses or transpiles the definition. The runtime profile
   selects the standard library before creating one Observable runtime for that
   view.
6. The browser writes runtime values, per-cell values, graph metadata, and
   render status to the view model.
7. Teardown disposes the runtime, model listeners, and DOM owned by that view.

Creating another view repeats steps 2 through 7 with a distinct model and
runtime. Closing one view leaves the notebook session and sibling views alive.

## Session synchronization

Python variable methods mutate the notebook session. `update_variables` sends
changed values and cleared interacted-input names to each active view.
`replace_variables` publishes when the environment changes or interacted input
state clears, then rebuilds each active runtime so released names return to
Notebook Kit ownership.

Browser input events on named `viewof` values publish writable serialized
values to the session. A sibling writes the value to its matching input, then
dispatches Observable `input` and `change` events when the value round-trips
unchanged. A target can coerce the property write before a failed round trip
suppresses those events. Equality checks at the session boundary prevent an
unchanged browser value from becoming another input update.

View readback stays on the originating `NotebookView` model. This keeps marimo
reactivity scoped to the wrapped view and prevents a readback update from
recreating the shared session.

## Readback ownership

Each view owns its render flag, graph snapshot, runtime values, and per-cell
values. Python reads them through `NotebookView.runtime_values`,
`NotebookView.cell_values()`, `NotebookView.value()`, and `NotebookView.graph`.

Each render attempt carries one monotonic token. Writes from an aborted or
superseded attempt are dropped. Changes that rebuild a view invalidate its
runtime snapshot before the replacement attempt publishes readback. The view
publishes its render flag, graph, and cell values as one revisioned snapshot.
Python rejects delayed snapshots after accepting a newer revision, which keeps
independent model-save requests from restoring stale readback.

## Source-backed notebooks

`from_html` keeps Notebook Kit HTML as source. When requested,
`embed_file_attachments` registers local attachments as data URL records and
`rewrite_imports` embeds local JavaScript modules in the source before it
reaches the browser.

`from_observablehq` fetches public notebooks and converts document API cells
into Notebook Kit HTML. The document `id` and `version` form an import
resolution token. Observable import cells are rewritten to public v4 module
URLs carrying that token, which preserves the dependency revisions selected by
the source notebook. Raw node collections keep their supplied import
specifiers because they do not carry a source document id and version.

## Runtime profiles

`NotebookModel.runtime_profile` records the standard library required by the
source:

- `notebook-kit` uses the builtins exported by
  `@observablehq/notebook-kit/runtime`. Python-authored notebooks and ordinary
  Notebook Kit HTML without profile metadata select this profile.
- `observable` creates a `Library` from `@observablehq/stdlib`. Every
  ObservableHQ constructor selects this profile.

The notebook session sends the profile through the dedicated
`_runtime_profile` trait. The widget carries it into `RuntimeOptions`, and the
runtime package constructs the selected builtin set before adding the shared
attachment registry, scoped document helpers, `width` and `dark` generators,
and Python variables. The profile is fixed for the notebook session and
inherited by each view. Serialized ObservableHQ source records the profile in
the root `data-pyobservablejs-runtime-profile` attribute. The HTML parser
restores that profile when `from_html` or `from_html_file` reconstructs the
model.
