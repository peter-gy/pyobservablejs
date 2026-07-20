# View composition

One Python `NotebookView` selection maps to one browser runtime. The notebook
session shares definitions and mutable state across views. Each view owns its
selection, DOM, readback, and teardown. [Select cells and create
subsets](../apps/docs/docs/render/select-cells.mdx) covers the user-facing
contract.

## Component map

| Component                                                                  | Ownership                                                                                                       |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [`_notebook.py`](../packages/pyobservablejs/src/observablejs/_notebook.py) | Normalizes selections, creates `NotebookView` models, validates readback revisions, and exposes the Python API. |
| [`model.ts`](../packages/widget/src/model.ts)                              | Reads session references, selections, notebook definitions, and render options from anywidget models.           |
| [`view.ts`](../packages/widget/src/view.ts)                                | Resolves the session model, owns rerender attempts, analyzes the notebook, and opens the runtime session.       |
| [`composition.ts`](../packages/widget/src/composition.ts)                  | Expands dependency closures and maps included cells to visible or hidden render targets.                        |
| [`session.ts`](../packages/widget/src/session.ts)                          | Owns the runtime, DOM root, Python variable synchronization, named input synchronization, and cleanup.          |
| [`cell-renderer.ts`](../packages/widget/src/cell-renderer.ts)              | Defines cells in the runtime, attaches observers, and publishes selected-cell values.                           |
| [`variable-sync.ts`](../packages/widget/src/variable-sync.ts)              | Applies Python variables and shares interacted input values through the notebook session.                       |
| [`readback.ts`](../packages/widget/src/readback.ts)                        | Publishes one revisioned graph, render status, and selected-cell value snapshot per view.                       |

The runtime package owns Notebook Kit analysis and definition. The widget
package owns composition because selection, visibility, model resolution, and
readback are anywidget concerns.

## Model boundary

Python exposes a plain `Notebook` controller and a renderable `NotebookView`
anywidget. The controller owns a private `_NotebookSession` anywidget model with
the definition, runtime profile, attachments, theme, Python variables, named
input values, renderer options, and cell keys. `NotebookView` owns a serialized
`_session` reference, normalized cell indices, and its `_readback` snapshot.

The frontend resolves `_session` through the anywidget host before reading the
session. The resolved model must carry `_model_role="session"`.

Derived graph and value state stays on `NotebookView`. Session mutations reach
active views while readback remains local to the originating view model.

## Session model reference

`NotebookView._session` is a `traitlets.Instance(_NotebookSession)` with
anywidget's widget-reference serializers. Python validates the private model
type, while the wire value preserves that model's identity. The frontend
resolves the reference through `host.getModel` before reading session state or
subscribing to changes.

The upstream protocol is defined by anywidget's [widget composition
specification](https://anywidget.dev/en/afm/#widget-composition). Each view
retains the session model identity while owning a separate output lifecycle:

```text
one public Notebook controller
  one private session model
        |
        +---- NotebookView model -> one runtime and output
        |
        +---- NotebookView model -> one runtime and output
```

Reusing a `Notebook` shares its private session state. Calling `.view()` again
creates another output lifecycle.

## Selection path

`Notebook.view(cells)` normalizes public selections before constructing the
view model:

1. `None` represents the full notebook.
2. `Notebook.cell()` resolves integer indices and string keys to stable handles.
   View selections accept those selectors and existing `NotebookCell` handles.
3. Indices are unique, in range, and sorted into notebook order.
4. `_cell_indexes` carries `None` or the normalized nonempty list to the browser.

The widget validates the wire shape again. `resolveSelectedIndexes` expands
`None` to every current cell index. `analyzeNotebook` produces the symbolic
graph, and `notebookViewIndexes` adds the transitive dependencies of every
selected cell.

`renderNotebookView` preserves two sets:

- `selectedIndexes` controls visible output and selected-cell readback.
- `renderIndexes` controls every cell defined in the runtime, including hidden
  dependencies.

Cells are defined in notebook order. A dependency-only wrapper receives
`hidden` and `aria-hidden="true"`. A selected cell still follows its Notebook
Kit `hidden` setting from the cell definition.

## Runtime lifecycle

Each `NotebookView` render attempt owns one `AbortController`. Starting another
attempt aborts the current attempt before resolving the session again.

The active attempt follows this order:

1. Read the selected indices and resolve the referenced session model.
2. Subscribe to session changes that require a new runtime.
3. Deserialize or construct the Notebook Kit notebook and analyze its graph.
4. Resolve selected and dependency indices.
5. Initialize the view readback graph for the current attempt.
6. Open a runtime session with variables, inputs, attachments, theme, and the
   source-selected standard library.
7. Define dependency and selected cells in that runtime.
8. Restore each saved named input value when its matching target registers.
9. Apply initial Python-owned values to registered targets. A target that
   registers later receives its value during registration.
10. Mark the view rendered after all selected cells publish settled state.

Changes to the view's private session reference or selection invalidate readback
and start another attempt. Changes to session source, spec, theme, attachments,
base URL, runtime profile, options, or cell keys follow the same rebuild path.

Python `set` variable updates enter the active runtime directly. A replacement
can release names back to notebook definitions, so it rebuilds the runtime with
the replacement environment.

## Shared input state

Each runtime registers named `viewof` targets with `RuntimeViewSync`. User input
events serialize supported writable target values into the session's
`_view_values` mapping. Unsupported values remain local to their runtime.
Sibling runtimes observe the mapping and write each shared value to the target
before checking the resulting wire value. A successful round trip dispatches
Observable `input` and `change` events. A failed round trip suppresses those
events, though the property write can already have coerced or cleared the
target.

Programmatic writes are marked in a `WeakSet` while events dispatch. Their event
listeners update dependent cells while skipping another session publication.
When Python takes ownership of a name, the session clears the corresponding
shared input value before applying the Python variable.

## Readback invariant

`_readback` is one immutable wire snapshot:

```text
revision
rendered
graph
cells
```

`ViewReadback` increments `revision` for every publication. An attempt token
rejects writes from aborted or superseded runtimes. The graph includes selected
cells and their dependency closure. The `cells` mapping includes selected cells
because Python value readback belongs to the outputs requested by that view.

The browser publishes render status, graph, and cells together. The Python
trait validator accepts a strictly newer revision and keeps its current state
when an independent model-save request arrives late. This ordering is required
for notebook frontends that transport model saves as separate requests.

## Teardown

The render signal owns model, input, and cell listeners plus the runtime
session. Aborting a render removes those listeners and disposes the Observable
runtime. `NotebookView.close()` closes one display model. `Notebook.close()`
closes every tracked view and then its private session model.
