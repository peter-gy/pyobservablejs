---
title: Widget Composition
description: How anywidget composition makes Observable cell widgets possible.
---

# Widget Composition

A `Notebook` owns one Notebook Kit runtime and passes `NotebookCell` references
through anywidget composition. The parent notebook resolves each child widget,
binds it to the runtime, and keeps the child model visible to Python.

The composition contract uses three browser-facing primitives:

- `signal`: an `AbortSignal` passed to `initialize` and `render` for cleanup.
- `initialize` exports: a widget instance can expose a JavaScript interface to
  other widgets.
- `host.getWidget(ref)` and `host.getModel(ref)`: a parent widget can resolve a
  child widget reference, render it into its own DOM, and access the child's
  underlying model.

Requires anywidget 0.11.0 or newer. The underlying browser contract comes from
[anywidget 0.11.0](https://github.com/manzt/anywidget/releases/tag/anywidget%400.11.0)
and the [widget composition RFC](https://github.com/manzt/anywidget/blob/main/rfcs/0001-widget-composition-and-signals.md).

Python-side composition uses `anywidget.WidgetTrait`. A widget-valued
trait validates that a value is an anywidget-compatible object, then serializes
that object as a reference string such as `anywidget:<model_id>`. The browser can
resolve that reference through the `host` object passed to `render`.

## Cell Widgets and Runtime Ownership

An Observable notebook is one reactive graph. Python users need two views into
that graph:

```python
notebook
notebook.cell("gain")
```

The full notebook display and ordinary `notebook.cell("name")` displays address
the same Observable runtime. Widget composition gives each cell a real anywidget
child model. The parent notebook owns runtime binding, DOM placement, and
cleanup. Ordinary standalone cells reuse live dependencies from the full
notebook. `viewof` standalone cells use an isolated DOM target and keep the
current value synchronized through the child model.

## Python Shape

When Python creates a notebook, it creates one `NotebookCell` child widget for
each Notebook Kit cell.

```python
notebook = obs.Notebook(
    obs.ojs('viewof gain = Inputs.range([0, 10])', name="gain"),
    obs.ojs("double = gain * 2", name="double"),
)

notebook.cell("gain")
notebook.cell("double")
```

Internally, the notebook model syncs those child widgets through `_cell_widgets`.
The trait is validated as a list of `NotebookCell` widgets, then serialized to
browser references:

```json
{
	"_cell_widgets": ["anywidget:<gain-model-id>", "anywidget:<double-model-id>"]
}
```

`_cell_widgets` is the Python-to-browser reference channel for cell widgets.

## Browser Shape

The notebook renderer reads `_cell_widgets`, resolves each reference, and binds
every child to the parent runtime.

```ts
const resolved = await Promise.allSettled(cellRefs.map((ref) => resolveCellWidget(host, ref, signal)));
```

For each child, `host.getWidget(ref)` returns the child widget's exports and
render function. `host.getModel(ref)` returns the child's model so the parent can
sync traits such as `_value_names` and `_values`.

`pyobservablejs` cell widgets export a small interface:

```ts
interface CellExports {
	bindRuntime(context: CellRenderContext): void;
	unbindRuntime(context: CellRenderContext): void;
	prepareComposedRender(el: HTMLElement, context: CellRenderContext): void;
}
```

The parent calls `bindRuntime` with the Notebook Kit runtime, the Notebook Kit
cell, notebook options, sibling cell models, and the value-sync adapter for that
cell. It calls the child's `render` method with the target cell container.

The child export protocol gives each cell widget the runtime context owned by
the parent notebook.

## Concrete Features Enabled

**One runtime, many Python names.** The parent creates one Notebook Kit runtime
for the notebook. Child models hold references to cells inside that runtime.

**Full notebook display.** The parent renders each child widget into a cell
container in notebook order. Child cells are anywidget models. The notebook
renderer controls their DOM placement.

**Standalone cell display.** A child displayed separately renders against the
latest parent runtime context. Ordinary display cells reuse live JavaScript
values from the notebook graph. `viewof` cells use an isolated render path with
its own DOM target and a current value synced through the cell model.

**Python-visible values.** Each child model syncs the variables exposed by its
cell. The parent listens to child `_value_names` and `_values`, then
aggregates them onto the notebook model for `notebook.values`.

**Graph and cell metadata.** The parent calls Notebook Kit `transpile` for each
cell, records definitions, references, runtime outputs, and dependency edges,
then syncs the graph to Python. Each graph entry is aligned with the matching
child model, so `notebook.cell_for_variable("name")` and `notebook.cell("name").info`
refer to the same runtime cell.

**Source panels and output state.** Pinned source rendering, error display, and
cell output state live in the child render path. Composition lets the parent
place those views. The child model owns its cell-specific state.

## Lifecycle and Cleanup

Notebook rendering is abortable.

- Structural model changes to `source`, `spec`, `attachments`, `base_url`,
  `options`, or `_cell_widgets` abort the current render and start a new one.
- Python variable changes on `_variables` patch the active Observable runtime.
  Ordinary variables use Observable Runtime `redefine`.
- `viewof` variables update the existing control target and emit its input event.
- Replacements that remove Python variable keys rebuild the notebook so original
  Observable definitions return.
- The same `AbortSignal` tears down child renders, Notebook Kit runtime state,
  attachment registrations, source highlighting, and trait listeners.

Observable cells can hold DOM nodes, event listeners, runtime variables,
attachment registrations, and async highlighting work. The signal chain gives
the parent one teardown boundary for all of that state.

:::{warning}
Widget composition is a host capability. Multi-cell notebooks require
child-widget reference resolution through `host.getWidget` and `host.getModel`.
When the host does not provide that contract, the rendered widget reports:
`This anywidget host does not expose composition APIs for cell widgets`.
:::

## Host Layouts and Runtime Ownership

Host layouts such as `ipywidgets.VBox`, `ipywidgets.HBox`, or marimo layout
helpers arrange existing widgets. anywidget composition supplies the browser
contract for this package: a parent owns a Notebook Kit runtime, resolves child
widgets inside its render function, passes a runtime context to those children,
and cascades cleanup through one browser lifecycle.

The parent notebook is the runtime owner. The child widgets are Python names
into that runtime. Use host layouts to arrange existing widgets. Use anywidget
composition when a parent must resolve child models and pass runtime context.
