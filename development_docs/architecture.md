# Architecture

`pyobservablejs` is browser-first. Python owns the notebook model. The browser
evaluates Observable JavaScript through Notebook Kit and synchronizes values
back through anywidget traits.

The installed wheel includes the browser runtime used by Jupyter and marimo
frontends.

```text
Full Notebook view

Python Notebook
  cells, variables, attachments, options
        |
        v
one anywidget parent model
        |
        v
lightweight TypeScript dispatcher
        |
        v
dynamically loaded parent renderer
        |
        v
one Notebook Kit runtime per view
        |
        v
parent-owned cell values and graph metadata
```

## Render lifecycle

1. Python creates a `Notebook` from authored cells, Notebook Kit HTML, or an
   ObservableHQ document.
2. The parent widget model sends source, specs, attachments, variables, and
   cell keys through traitlets.
3. The widget entry dispatcher loads the parent renderer on demand.
4. Notebook Kit parses or transpiles the notebook and creates one Observable
   runtime for the rendered view.
5. The browser renders logical cells and writes graph metadata plus one
   `_cell_values` snapshot on the parent model.
6. Python decodes that snapshot through `Notebook.runtime_values`,
   `Notebook.cell_values()`, and materialized `NotebookCell` handles.
7. Teardown disposes the browser runtime, model listeners, and cell DOM owned by
   that view.

## Cell projection composition

`NotebookCell` is a cached projection handle. `Notebook.cell_at`,
`Notebook.cell_by_key`, and `Notebook.cell_for_variable` materialize one handle.
`Notebook.cells` materializes every handle. Full notebook rendering and
readback operate directly on the parent model.

The cached handle has no comm. Each display creates a private anywidget adapter
whose lifetime belongs to that display. The adapter carries a typed
`traitlets.Instance(Notebook)` reference and a cell index. The Anywidget
serializer sends the parent as an `anywidget:<model-id>` reference. A direct
cell view resolves that reference through the Anywidget Front-End Module
`host.getWidget` API available as of anywidget 0.11. It installs a small
projection context on the target element and invokes the parent renderer. The
parent evaluates the selected cell and its hidden dependency closure in one
Notebook Kit runtime.

Reactive hosts may close a display adapter when its owning cell reruns. The
next display creates a new adapter and model id while the public handle keeps
its identity and reads the same parent-owned snapshot.

The entry module stays small so cell handles can resolve their parent before
the parent renderer loads. The dynamically imported parent module owns runtime
construction, model listeners, readback, and teardown.

## Readback ownership

The parent model owns `_cell_values`, keyed by cell index. Each record carries
the render flag, synchronized names, and serialized values. Full notebook views
and direct cell projections publish through the same `NotebookReadback`
coordinator.

Each render attempt has a model generation and view version. Writes from an
aborted or superseded attempt are dropped. Closing one view preserves snapshots
published by another live view. Changes to notebook inputs invalidate the
generation, graph, full-render gate, and cell snapshots together.

## Variable updates

`update_variables` sends a patch. The frontend applies the patch to the live
runtime. `replace_variables` sends a full replacement and releases names omitted
from the replacement.

`viewof` cells are browser-owned. Python can override a variable with the same
name, and the frontend writes the value through the runtime path used by
Observable inputs.

## Source-backed notebooks

`from_html` keeps Notebook Kit HTML as source. Portable mode embeds local
attachments and rewrites local imports before the source reaches the browser.

`from_observablehq` fetches public notebooks and converts document API cells
into Notebook Kit HTML before using the same source-backed rendering path.
