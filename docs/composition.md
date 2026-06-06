---
title: Widget Composition
description: How anywidget model composition renders Observable cells through one notebook runtime.
---

# Widget Composition

A rendered `Notebook` owns one Notebook Kit runtime. Python creates one
`NotebookCell` child widget for each Notebook Kit cell, then the browser resolves
those child models through native anywidget composition and renders their
Notebook Kit cells inside the parent notebook output.

```python
notebook = obs.Notebook(
    obs.ojs('viewof gain = Inputs.range([0, 10])', name="gain"),
    obs.ojs("double = gain * 2", name="double"),
)

notebook
notebook.cell("gain").values
```

`NotebookCell` is a Python handle for one cell's synchronized values and graph
metadata. Display the parent `Notebook` to render cell outputs.

## anywidget Contract

Multi-cell notebooks require an anywidget host that can resolve widget model
references. The browser renderer uses:

- `signal`: the render abort signal used for cleanup.
- `host.getModel(ref)`: resolves the child widget model when the host provides
  the composition API.
- `model.widget_manager.get_model(model_id)`: resolves the child model through
  the same anywidget model lookup used by `host.getModel` when the `host` prop
  is unavailable.

Python-side composition uses `anywidget.WidgetTrait`. The `_cell_widgets` trait
contains real `NotebookCell` widgets, and anywidget serializes them to references
such as `anywidget:<model_id>` for the browser host.

```json
{
	"_cell_widgets": ["anywidget:<gain-model-id>", "anywidget:<double-model-id>"]
}
```

When neither model lookup path is available, a multi-cell notebook reports:

```text
This anywidget host cannot resolve child widget models
```

## Browser Flow

The parent notebook renderer performs the composition work in this order:

1. Parse `source` or `spec` into a Notebook Kit notebook.
2. Resolve every `_cell_widgets` reference to an anywidget model.
3. Register attachments for this widget instance.
4. Create one Notebook Kit runtime with Observable builtins and Python variables.
5. Transpile cells with Notebook Kit and sync `_graph` to Python.
6. Render each Notebook Kit cell in the parent cell container.
7. Mirror exposed Observable values into child `_values` traits.
8. Aggregate child values onto the parent notebook for `notebook.values`.

The parent owns the Notebook Kit runtime, DOM placement, attachment lifecycle,
source panels, value sync, and graph sync. Child widgets own their model traits
and provide Python handles for synchronized values and graph metadata.

## Values and Graph Metadata

Each child model syncs the values exposed by its cell. The parent listens to
child `_value_names` and `_values`, then aggregates unique values onto the
notebook model.

```python
notebook.cell("gain").value
notebook.values
```

Graph metadata comes from Notebook Kit `transpile`. The browser records
definitions, references, runtime outputs, and dependency edges, then syncs them
to Python.

```python
notebook.graph
notebook.cell("gain").info
notebook.cell_for_variable("gain")
```

If one child widget cannot resolve, the parent still syncs graph metadata for
the notebook and value updates for resolved cells. The unresolved cell container
shows the resolution error.

## Lifecycle and Cleanup

Notebook rendering is abortable.

- Structural model changes to `source`, `spec`, `attachments`, `base_url`,
  `options`, or `_cell_widgets` abort the current render and start a new one.
- Python variable changes on `_variables` patch the active Observable runtime.
  Ordinary variables use Observable Runtime `redefine`.
- `viewof` variables update the existing control target and emit its input event.
- Replacements that remove Python variable keys rebuild the notebook so original
  Observable definitions return.
- The same `AbortSignal` tears down child model listeners, the Notebook Kit runtime,
  attachment registrations, source highlighting, and trait listeners.

Host layouts such as `ipywidgets.VBox`, `ipywidgets.HBox`, or marimo layout
helpers arrange existing widgets. anywidget composition is the browser contract
used when a parent widget must resolve child models and render their cells inside
its own lifecycle.
