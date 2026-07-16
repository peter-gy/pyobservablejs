---
title: Notebook
description: Notebook definitions, renderable views, shared values, and browser lifecycle.
---

# `Notebook`

`Notebook` stores cells, variables, attachments, and display options. Call
`view()` to create a renderable view of the complete notebook or a selected
group of cells.

```python
import observablejs as obs

notebook = obs.Notebook(
    obs.md("# Summary"),
    obs.ojs("answer = 40 + 2", key="answer"),
    obs.ojs("md`Answer: **${answer}**`"),
)

full_view = notebook.view()
full_view
```

## `Notebook(*cells, ...)`

```python
obs.Notebook(
    *cells,
    title="Untitled",
    theme="air",
    files=None,
    base_path=None,
    variables=None,
    show_pinned_source=False,
)
```

Creates a Python-authored notebook definition and session. See [Cells](cells.md),
[variables](variables.md), [file attachments](file-attachments.md), and
[notebook themes](notebook-themes.md) for the nested input contracts.

| Argument             | Default      | Contract                                                                                                |
| -------------------- | ------------ | ------------------------------------------------------------------------------------------------------- |
| `*cells`             | Empty        | `Cell` objects from `ojs`, `js`, `md`, `html`, or direct `Cell` construction.                           |
| `title`              | `"Untitled"` | Notebook Kit document title used by `spec` and generated HTML.                                          |
| `theme`              | `"air"`      | Theme name or `{"light": name, "dark": name}` mapping. Names are normalized to lowercase.               |
| `files`              | `None`       | Named local paths, URLs, or attachment records for `FileAttachment`.                                    |
| `base_path`          | `None`       | Base directory for relative local paths in `files`. The current working directory is used when omitted. |
| `variables`          | `None`       | Mapping of Python-owned Observable variable names to serializable values.                               |
| `show_pinned_source` | `False`      | Sends `show_source=True` to the renderer so selected pinned cells appear in the source panel.           |

### Construction errors

- `TypeError` reports a non-`Cell` positional input, a non-mapping `variables`
  value, an unsupported variable value, or an invalid theme value type.
- `ValueError` reports an unknown cell mode, duplicate nonempty cell keys, an
  invalid or reserved variable name, an unknown theme, or a malformed theme
  mapping.
- `FileNotFoundError` reports a missing explicit local attachment.
- Other `OSError` subclasses report local attachment read or metadata failures.

## Create views

### `Notebook.view(cells=None)`

```python
full_view = notebook.view()
summary_view = notebook.view(cells=[0, 1])
keyed_view = notebook.view(cells=["answer"])
```

Returns a new `NotebookView`. With `cells=None`, the view selects the complete
notebook in cell order. `cells` accepts a sequence of cell indices, Python cell
keys, or `NotebookCell` handles. The selected cells and their dependencies
evaluate in one Notebook Kit runtime after a frontend mounts the view. Negative
indices count from the end. Dependency cells evaluate with hidden output unless
they are also selected.

Each call creates a view with its own runtime and readback state. Views from
the same notebook share named Python variables. A browser interaction with a
named `viewof` input becomes shared state for current and future views when
its value has a [supported shared shape](variables.md#python-values-and-viewof-inputs).
A sibling attempts to write that state to its matching input and dispatches
`input` and `change` events when the value round-trips unchanged. A target that
coerces an incompatible value may still change before those events are
suppressed.

See [Views and composition](../guides/views-and-composition.md) for the full,
focused, and composite selection patterns.

An empty selection, a duplicate selection, or a handle from another notebook
raises `ValueError`. An invalid selection type raises `TypeError`. Unknown keys
raise `KeyError`, and out-of-range indices raise `IndexError`. Calling `view()`
after `notebook.close()` raises `RuntimeError`.

### `Notebook.cell_at(index)`

```python
cell = notebook.cell_at(0)
data_view = cell.view()
```

Returns the cached `NotebookCell` selection handle at `index`. Nonnegative
indices count from the start, negative indices count from the end, and an
out-of-range index raises `IndexError`.

### `Notebook.cell_by_key(key)`

```python
cell = notebook.cell_by_key("answer")
answer_view = cell.view()
```

Returns the cached selection handle whose Python key equals `key`. It is
available before render. Missing and ambiguous keys raise `KeyError`.

### `Notebook.cells`

```python
cells: tuple[obs.NotebookCell, ...] = notebook.cells
```

Returns cached selection handles in notebook order. Accessing this property
materializes every handle. While the notebook is open, each handle keeps object
identity across later `cells` and lookup calls.

## `NotebookCell`

`NotebookCell` identifies one cell in a notebook definition. Its `key` and
`name` attributes expose the Python key and Notebook Kit name as strings. An
unset value is `""`. Call `view()` to create a renderable view for the cell and
its dependencies.

```python
cell = notebook.cell_by_key("answer")
answer_view = cell.view()
```

### `NotebookCell.view()`

Returns a new `NotebookView` selected to this cell. The view owns its browser
runtime, graph, and synchronized values. The selected cell renders while its
dependency closure evaluates with hidden output.

## `NotebookView`

`NotebookView` is the anywidget display object for a full, focused, or composite
selection. Its browser runtime starts when Jupyter displays it or marimo mounts
it through `mo.ui.anywidget`.

```python
obs.NotebookView(notebook, cell_indexes=None)
```

The constructor accepts a `Notebook` session and an optional sequence of
zero-based cell indices. `Notebook.view()` and `NotebookCell.view()` provide
normalized selection lookup by index, key, or handle.

A non-sequence `cell_indexes` value raises `TypeError`. Invalid, duplicate, or
out-of-range entries raise `traitlets.TraitError`. A closed notebook raises
`RuntimeError`.

```python
full_view = notebook.view()
full_view
```

In marimo, wrap each view separately.

```python
import marimo as mo

widget = mo.ui.anywidget(full_view)
```

### Session and selection

| Member              | Contract                                                                 |
| ------------------- | ------------------------------------------------------------------------ |
| `notebook`          | The `Notebook` session rendered by this view.                            |
| `cell_indexes`      | Selected indices in notebook order, or `None` for the complete notebook. |
| `variables`         | A shallow copy of the session's current Python-owned variables.          |
| `update_variables`  | Delegates a variable patch to the notebook session.                      |
| `replace_variables` | Delegates a complete variable replacement to the notebook session.       |
| `reset_variables`   | Releases named Python variables through the notebook session.            |

Variable changes apply to every active view from the session.

A `NotebookView` owns one live writable output. Create another view from the
session when the same selection must appear in two outputs at once. A view can
render again after its previous output is torn down.

### Browser lifecycle

| State                   | `has_rendered` | `has_graph_snapshot` | Available readback                          |
| ----------------------- | -------------- | -------------------- | ------------------------------------------- |
| Created                 | `False`        | `False`              | View selection                              |
| Graph synchronized      | `False`        | `True`               | Graph metadata                              |
| Selected cells rendered | `True`         | `True`               | Values, per-cell values, and graph metadata |

A variable replacement or release that triggers a runtime rebuild clears both
gates until the replacement graph and render snapshots synchronize.

### `NotebookView.has_rendered`

Returns whether the browser has synchronized a completed render for this view.

### `NotebookView.has_graph_snapshot`

Returns whether this view has synchronized graph metadata.

### `NotebookView.graph`

```python
graph: obs.NotebookGraph = full_view.graph
```

Returns the decoded immutable graph snapshot for the cells evaluated by this
view. A selected view includes its selected cells and their dependency closure.
It raises `NotRenderedError` before graph synchronization.

### `NotebookView.runtime_values`

```python
values: dict[str, object] = full_view.runtime_values
```

Returns a new dictionary of decoded values from this view. Names produced by
more than one selected cell are omitted because they have no unique owner. The
property raises `NotRenderedError` before the view renders.

### `NotebookView.cell_values()`

```python
values: tuple[obs.CellValues, ...] = full_view.cell_values()
```

Returns one `CellValues` record per selected cell in notebook order. It raises
`NotRenderedError` before the view renders.

### `NotebookView.value(name)`

```python
answer = full_view.value("answer")
```

Returns `full_view.runtime_values[name]`. It raises `NotRenderedError` before
the view renders and `KeyError` when no rendered value matches `name`.

### `NotebookView.close()`

Closes this display model and removes it from the session's active views. Other
views from the notebook remain active. Repeated calls are no-ops, and
previously synchronized readback remains available. Variable mutators on the
closed view raise `RuntimeError`.

See [Values and graph](values-and-graph.md) for decoded value types and graph
records.

## Construction-time state

### `Notebook.source`

```python
source: str = notebook.source
```

Returns Notebook Kit HTML owned by a source-backed notebook. Python-authored
notebooks return `""`. `from_html` returns its prepared source, including local
JavaScript import rewrites when requested. ObservableHQ constructors return the
Notebook Kit HTML generated from imported nodes. Document-based constructors
pin Observable notebook imports when the source includes its `id` and
`version`. Generated ObservableHQ source preserves its classic standard-library
semantics through `from_html` and `from_html_file`.

### `Notebook.spec`

```python
spec: dict[str, object] = notebook.spec
```

Returns a shallow copy of the Notebook Kit spec for a Python-authored notebook.
The dictionary contains `title`, `theme`, and `cells`. Source-backed notebooks
return an empty dictionary because their `source` is the rendering input.

### `Notebook.attachments`

```python
attachments: dict[str, dict[str, object]] = notebook.attachments
```

Returns a shallow copy of the named `FileAttachment` records. Local files appear
as data URLs. URL-backed records retain their URL and optional metadata. See
[File attachments](file-attachments.md) for path resolution and serialized HTML
boundaries.

### `Notebook.base_url`

```python
base_url: str = notebook.base_url
```

Returns the base URL for attachment names absent from `attachments`.
Constructors use `""`, which selects the browser document base URI.

### `Notebook.options`

```python
options: dict[str, object] = notebook.options
```

Returns a shallow copy of renderer options. Every notebook includes
`{"show_source": bool}`.

### `Notebook.theme`

```python
theme = notebook.theme
notebook.theme = "slate"
```

Returns the normalized theme name or light and dark mapping. Assigning a valid
theme on a Python-authored notebook updates its active views and
`notebook.spec`. Source-backed notebooks take their theme from source HTML, and
changing that theme raises `traitlets.TraitError`.

### `Notebook.variables`

```python
variables: dict[str, object] = notebook.variables
```

Returns a shallow copy of the Python-owned variable environment. See
[Variables](variables.md) for serialization and mutation contracts.

## Variable mutation

### `Notebook.update_variables(values=None, /, **kwargs)`

Merges a mapping or iterable of key-value pairs into the Python-owned
environment and returns `None`. Active views receive a live `set` update for
wire-level changes and names whose interacted input state is cleared. Keyword
arguments win over matching entries in `values`. Empty updates are no-ops. A
wire-identical update is also a no-op when it clears no interacted state.

### `Notebook.replace_variables(values=None, /, **kwargs)`

Replaces the Python-owned environment and returns `None`. Omitted names are
released. Active views rebuild when the serialized environment changes or the
replacement clears interacted input state, so notebook definitions resume
ownership of released names. A wire-identical replacement with no interacted
state is a no-op.

### `Notebook.reset_variables(*names)`

Releases listed names that Python currently owns and returns `None`. Empty calls
and unknown names are no-ops. Releasing at least one name follows the
replacement lifecycle.

These methods apply the name and value errors documented on the
[Variables](variables.md) page.

## `Notebook.close()`

Closes the notebook session and every live `NotebookView` created from it.
Repeated calls are no-ops. Creating views, changing variables, or assigning a
theme after close raises `RuntimeError`. Construction-time metadata remains
readable.

## `Notebook.to_notebook_html()`

```python
html: str = notebook.to_notebook_html()
```

Returns Notebook Kit HTML. Python-authored notebooks serialize the current
`spec`. Source-backed notebooks return `source`, including explicit source
rewrites. File attachment records and Python variables remain session state, as
described by [File attachments](file-attachments.md) and
[Variables](variables.md). ObservableHQ-derived HTML preserves classic
standard-library semantics when loaded again through `from_html` or
`from_html_file`.

## Alternative constructors

`Notebook` also provides these class methods:

```python
Notebook.from_html(source, *, files=None, base_path=None, embed_file_attachments=False, rewrite_imports=False, variables=None, show_pinned_source=False)
Notebook.from_html_file(path, *, files=None, embed_file_attachments=False, rewrite_imports=False, variables=None, show_pinned_source=False)
Notebook.from_observablehq(specifier, *, variables=None, files=None, show_pinned_source=False, timeout=30)
Notebook.from_observablehq_document(document, *, title=None, variables=None, files=None, show_pinned_source=False)
Notebook.from_observablehq_page_data(page_data, *, title=None, variables=None, files=None, show_pinned_source=False)
Notebook.from_observablehq_nodes(nodes, *, observable_files=None, title="Untitled", variables=None, files=None, show_pinned_source=False)
```

Each method returns a source-backed `Notebook`. ObservableHQ constructors use
the classic Observable standard library. See
[Source notebooks](source-notebooks.md) for accepted source shapes, defaults,
network failures, file precedence, and source-revision import resolution.
