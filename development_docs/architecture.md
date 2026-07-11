# Architecture

`pyobservablejs` is browser-first. Python owns notebook definitions,
serialization, attachments, and session state. The browser evaluates
Observable JavaScript through Notebook Kit. A `NotebookView` owns each browser
runtime and its synchronized readback.

The installed wheel includes the browser runtime used by Jupyter and marimo.

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
browser input values shared across its views.

`NotebookCell` owns a stable cell selection. `NotebookCell.view()` creates a
`NotebookView` for the selected cell and its dependency closure. The resulting
view owns the browser runtime and readback state.

`NotebookView` owns one anywidget display model, one Notebook Kit runtime, the
selected cell indices, render gates, runtime values, per-cell values, and graph
metadata. `Notebook.view()` selects every cell. `Notebook.view(cells=[...])`
creates a composite selection that evaluates in one runtime.

Separate views from one notebook share named Python variables. A browser input
event on a named `viewof` value becomes session state for current and future
views. Untouched source defaults remain local to each runtime. Use a composite
view when multiple cells require the same runtime and graph snapshot.

## Render lifecycle

1. Python creates a `Notebook` from authored cells, Notebook Kit HTML, or an
   ObservableHQ document.
2. Python creates a `NotebookView` with a full, single-cell, or composite
   selection.
3. Jupyter displays the view, or marimo wraps that view with
   `mo.ui.anywidget`.
4. The frontend resolves the referenced notebook session and reads its source,
   spec, attachments, variables, options, and shared input values.
5. Notebook Kit parses or transpiles the definition and creates one Observable
   runtime for that view.
6. The browser writes runtime values, per-cell values, graph metadata, and
   render status to the view model.
7. Teardown disposes the runtime, model listeners, and DOM owned by that view.

Creating another view repeats steps 2 through 7 with a distinct model and
runtime. Closing one view leaves the notebook session and sibling views alive.

## Session synchronization

Python variable methods mutate the notebook session. `update_variables` sends
a patch to each active view. `replace_variables` publishes a complete
environment and rebuilds each active runtime so released names return to
Notebook Kit ownership.

Browser input events on named `viewof` values publish the interacted value to
the session. Sibling views apply that value through the Observable input path.
Equality checks at the session boundary prevent an unchanged browser value from
becoming another input update.

View readback stays on the originating `NotebookView` model. This keeps marimo
reactivity scoped to the wrapped view and prevents a readback update from
recreating the shared session.

## Readback ownership

Each view owns its render flag, graph snapshot, runtime values, and per-cell
values. Python reads them through `NotebookView.runtime_values`,
`NotebookView.cell_values()`, `NotebookView.value()`, and `NotebookView.graph`.

Render attempts carry a generation and view version. Writes from an aborted or
superseded attempt are dropped. Input changes invalidate the affected view's
runtime snapshot before the replacement attempt publishes readback.

## Source-backed notebooks

`from_html` keeps Notebook Kit HTML as source. Portable mode embeds local
attachments and rewrites local imports before the source reaches the browser.

`from_observablehq` fetches public notebooks and converts document API cells
into Notebook Kit HTML before using the same source-backed rendering path.
