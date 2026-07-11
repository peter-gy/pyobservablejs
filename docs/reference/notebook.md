---
title: Notebook
description: Notebook construction, public members, return values, errors, and browser lifecycle.
---

# `Notebook`

`Notebook` represents an Observable Notebook Kit document and displays as an
anywidget in supported notebook frontends. It owns authored or source HTML, file
attachments, Python variables, and browser-synchronized readback. A displayed
notebook evaluates all of its logical cells through one Notebook Kit runtime.

```python
import observablejs as obs

notebook = obs.Notebook(
    obs.md("# Summary"),
    obs.ojs("answer = 40 + 2", key="answer"),
    obs.ojs("md`Answer: **${answer}**`"),
)
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

Creates a Python-authored notebook and prepares its widget state. Display the
returned widget in Jupyter or marimo to start the browser runtime, render the
notebook, and synchronize values.

| Argument             | Default      | Contract                                                                                                |
| -------------------- | ------------ | ------------------------------------------------------------------------------------------------------- |
| `*cells`             | Empty        | `Cell` objects from `ojs`, `js`, `md`, `html`, or direct `Cell` construction.                           |
| `title`              | `"Untitled"` | Notebook Kit document title used by `spec` and generated HTML.                                          |
| `theme`              | `"air"`      | Theme name or `{"light": name, "dark": name}` mapping. Names are normalized to lowercase.               |
| `files`              | `None`       | Named local paths, URLs, or attachment records for `FileAttachment`.                                    |
| `base_path`          | `None`       | Base directory for relative local paths in `files`. The current working directory is used when omitted. |
| `variables`          | `None`       | Mapping of Python-owned Observable variable names to serializable values.                               |
| `show_pinned_source` | `False`      | Sends `show_source=True` to the renderer so pinned cells appear in the source panel.                    |

Construction returns a `Notebook` instance. See [Cells](cells.md),
[variables](variables.md), [file attachments](file-attachments.md), and
[notebook themes](notebook-themes.md) for the nested input contracts.

### Construction errors

- `TypeError` reports a non-`Cell` positional input, a non-mapping `variables`
  value, an unsupported variable value, or an invalid theme value type.
- `ValueError` reports an unknown cell mode, duplicate nonempty cell keys, an
  invalid or reserved variable name, an unknown theme, or a malformed theme
  mapping.
- `FileNotFoundError` reports a missing explicit local attachment.
- Other `OSError` subclasses report local attachment read or metadata failures.

## Construction-time state

These members are available immediately after construction.

### `Notebook.source`

```python
source: str = notebook.source
```

Returns Notebook Kit HTML owned by a source-backed notebook. Python-authored
notebooks return `""`. `from_html` returns its prepared source, including local
JavaScript import rewrites when requested. ObservableHQ constructors return the
Notebook Kit HTML generated from imported nodes.

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
`{"show_source": bool}`. ObservableHQ imports also include a
`runtime_compatibility` mapping for classic Observable helpers.

### `Notebook.theme`

```python
theme = notebook.theme
notebook.theme = "slate"
```

Returns the normalized theme name or light and dark mapping. Assigning a valid
theme on a Python-authored notebook updates the displayed notebook and
`notebook.spec`. Source-backed notebooks take their theme from source HTML, and
changing that theme raises `traitlets.TraitError`.

### `Notebook.variables`

```python
variables: dict[str, object] = notebook.variables
```

Returns a shallow copy of the Python-owned variable environment. See
[Variables](variables.md) for serialization and mutation contracts.

### `Notebook.cells`

```python
cells: tuple[obs.NotebookCell, ...] = notebook.cells
```

Returns cached `NotebookCell` projection handles in notebook order. Accessing
this property materializes every handle. Each handle keeps object identity
across later `cells` and lookup calls.

Use `cell_at` or `cell_by_key` when code needs one cell. Full notebook display,
`runtime_values`, and `cell_values()` read state stored on the `Notebook` and
keep projection handles lazy.

## Variable mutation

### `Notebook.update_variables(values=None, /, **kwargs)`

Merges a mapping or iterable of key-value pairs into the Python-owned
environment and returns `None`. A displayed notebook receives a live `set`
update. Keyword arguments win over matching entries in `values`. Empty updates
are no-ops.

### `Notebook.replace_variables(values=None, /, **kwargs)`

Replaces the Python-owned environment and returns `None`. Omitted names are
released. A displayed notebook rebuilds the runtime so notebook definitions
resume ownership of released names.

### `Notebook.reset_variables(*names)`

Releases listed names that Python currently owns and returns `None`. Empty calls
and unknown names are no-ops. Releasing at least one name follows the
replacement lifecycle.

`update_variables` and `replace_variables` apply the name and value errors
documented on the [Variables](variables.md) page.

## Cell lookup

### `Notebook.cell_at(index)`

```python
cell = notebook.cell_at(0)
```

Returns the cached projection handle at `index`, materializing it on first
access. Nonnegative indices count from the start, negative indices count from
the end, and an out-of-range index raises `IndexError`.

### `Notebook.cell_by_key(key)`

```python
cell = notebook.cell_by_key("answer")
```

Returns the cached projection handle whose Python key equals `key`,
materializing it on first access. It is available before render. Missing and
ambiguous keys raise `KeyError`.

### `Notebook.cell_for_variable(name)`

```python
cell = notebook.cell_for_variable("answer")
```

Returns the cached projection handle whose synchronized graph record defines
`name`, materializing it on first access. It requires a graph snapshot and
raises `NotRenderedError` before one arrives. Unknown and ambiguous definitions
raise `KeyError`.

## Browser lifecycle

`has_rendered` tracks a full notebook render. `has_graph_snapshot` tracks graph
metadata produced by either a notebook render or a direct cell projection.

| State                        | `has_rendered`    | `has_graph_snapshot` | Available readback                                         |
| ---------------------------- | ----------------- | -------------------- | ---------------------------------------------------------- |
| Constructed, never displayed | `False`           | `False`              | Construction-time state and cell lookup by position or key |
| One `NotebookCell` displayed | `False`           | `True` after sync    | That cell's values and notebook graph metadata             |
| Full `Notebook` displayed    | `True` after sync | `True` after sync    | Notebook values, all cell values, and graph metadata       |

### `Notebook.has_rendered`

```python
ready: bool = notebook.has_rendered
```

Returns whether the browser has synchronized a full notebook render. Directly
displaying a `NotebookCell` leaves this value false.

### `Notebook.has_graph_snapshot`

```python
ready: bool = notebook.has_graph_snapshot
```

Returns whether the synchronized graph trait contains `cells` and `edges`
lists. A direct cell projection can make this true before the full notebook
renders.

### `Notebook.graph`

```python
graph: obs.NotebookGraph = notebook.graph
```

Returns the decoded immutable graph snapshot. It raises `NotRenderedError`
before graph synchronization. See [Values and graph](values-and-graph.md) for
`NotebookGraph`, `CellInfo`, and `DependencyEdge`.

### `Notebook.runtime_values`

```python
values: dict[str, object] = notebook.runtime_values
```

Returns a new dictionary of decoded notebook-level browser values. It requires
a full notebook render and raises `NotRenderedError` beforehand.

### `Notebook.cell_values()`

```python
values: tuple[obs.CellValues, ...] = notebook.cell_values()
```

Returns one `CellValues` record per logical cell in notebook order. It requires
a full notebook render and raises `NotRenderedError` beforehand. Reading these
records keeps `NotebookCell` handles lazy.

### `Notebook.value(name)`

```python
answer = notebook.value("answer")
```

Returns `notebook.runtime_values[name]`. It raises `NotRenderedError` before a
full notebook render and `KeyError` when the rendered value mapping has no
matching name.

## `Notebook.to_notebook_html()`

```python
html: str = notebook.to_notebook_html()
```

Returns Notebook Kit HTML. Python-authored notebooks serialize the current
`spec`. Source-backed notebooks return `source`, including explicit source
rewrites. File attachment records and Python variables remain widget state, as
described by [File attachments](file-attachments.md) and
[Variables](variables.md).

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

Each method returns a source-backed `Notebook`. See
[Source notebooks](source-notebooks.md) for accepted source shapes, defaults,
network failures, file precedence, and import compatibility.
