---
title: API
description: Public Python API reference for pyobservablejs.
---

# API

Import the package as `obs`:

```python
import pyobservablejs as obs
```

## Notebook

```python
obs.Notebook(
    *cells,
    title="Untitled",
    theme="air",
    mode="ojs",
    attachments=None,
    base_path=None,
    variables=None,
    show_pinned_source=False,
)
```

Create an anywidget model from Python-authored cells. Displaying the notebook in
a compatible frontend renders the cells with the Observable Notebook Kit browser
runtime.

- `*cells`: strings or helper-created cell objects.
- `title`: title written to exported Notebook Kit HTML.
- `theme`: Notebook Kit theme, usually `"air"`.
- `mode`: default mode for plain string cells.
- `attachments`: mapping from `FileAttachment` names to paths, URLs, or metadata.
- `base_path`: base path for relative attachments.
- `variables`: Python values exposed as OJS variables. Matching notebook variables
  are overridden.
- `show_pinned_source`: render source for pinned cells.

Plain string cells use `mode="ojs"` by default.

Browser-populated fields such as `values`, `graph`, and cell metadata are empty
until the widget has rendered.

### `Notebook.variables`

```python
notebook.variables
notebook.update_variables(rows=rows, floor=0.04)
notebook.replace_variables({"rows": rows})
notebook.reset_variables("floor")
```

`variables` returns the current Python-owned variable environment exposed to the Observable runtime.
TypeScript revives the values as Observable builtins and redefines matching
notebook variables so dependent cells settle on the Python-provided values.

`update_variables` merges new keys into the current mapping before syncing the trait.
Use it when a stable notebook should receive Python-side state changes from a
notebook host such as marimo or Jupyter.

`replace_variables(...)` swaps the full Python-owned environment. `reset_variables(...)`
removes one or more Python-owned variables.

When replacement or reset removes keys, the browser rebuilds the runtime to
restore the notebook's original definitions for those names.

### `Notebook.cells`

```python
notebook.cells
```

Tuple of `NotebookCell` widgets in notebook order. Each Notebook Kit cell has one
child widget.

### `Notebook.cell`

```python
notebook.cell(key)
```

Return a `NotebookCell` by zero-based index or Python name. Ambiguous or
unknown names raise `KeyError`.

### `Notebook.cell_for_variable`

```python
notebook.cell_for_variable(name)
```

Return the unique `NotebookCell` whose graph metadata defines the Observable
variable `name`. Graph metadata is available after the browser renders the
notebook.

### `Notebook.values`

```python
notebook.values
```

Dictionary of the latest browser-synchronized values for named cells and exposed
variables. Before the first browser render, this may be empty.

### `Notebook.value`

```python
notebook.value(name)
```

Return `notebook.values[name]`. Use this to read a single `viewof` input or
computed cell value after browser evaluation.

For `viewof` cells, synchronized values contain the current input values. DOM
elements stay in the browser.

### `Notebook.graph`

```python
notebook.graph
```

Return the latest `NotebookGraph`, or `None` before the first browser render.
The graph is produced from Notebook Kit transpilation metadata in TypeScript.

### `Notebook.to_notebook_html`

```python
notebook.to_notebook_html()
```

Return Notebook Kit HTML. Python-authored notebooks are serialized from `spec`.
Source-backed notebooks return their original HTML source.

### `Notebook.from_file`

```python
obs.Notebook.from_file(
    path,
    portable=True,
    variables=None,
    attachments=None,
    show_pinned_source=False,
)
```

Load Notebook Kit HTML from disk. With `portable=True`, local
`FileAttachment(...)` references and relative JavaScript imports are embedded.
Pass `variables={...}` to set or override OJS variables.

### `Notebook.from_html`

```python
obs.Notebook.from_html(
    source,
    portable=True,
    variables=None,
    attachments=None,
    base_path=None,
    show_pinned_source=False,
)
```

Create a source-backed notebook from an HTML string. `base_path` is used to
resolve local attachments and imports when `portable=True`. Pass `variables={...}` to
set or override OJS variables.

### `Notebook.from_url`

```python
obs.Notebook.from_url(
    url,
    variables=None,
    attachments=None,
    show_pinned_source=False,
    timeout=30,
)
```

Load a public Observable notebook through the document API. `url` can be a full
Observable URL, a slug such as `@mbostock/saving-svg`, a 16-character notebook
id, or an Observable document API URL.

Observable API `js` nodes are converted to Notebook Kit `ojs` cells. Uploaded
files in the document response become URL-backed `FileAttachment` entries. Any
explicit `attachments` mapping overrides discovered remote attachments with the
same name. Pass `variables={...}` to set or override variables in the loaded
notebook.

## NotebookCell

`NotebookCell` is the child anywidget model for one rendered Observable cell.
Users usually obtain cell widgets with `notebook.cell(...)`.

### `NotebookCell.value`

```python
notebook.cell("gain").value
```

Return the cell's browser-synchronized value when it is unambiguous. Use
`notebook.cell("gain").values["gain"]` for explicit named access.

### `NotebookCell.values`

```python
notebook.cell("gain").values
```

Return all browser-synchronized values exposed by the cell.

### `NotebookCell.info`

```python
notebook.cell("gain").info
```

Return the matching `CellInfo`, or `None` before graph metadata is available.

### Cell metadata shortcuts

```python
cell.defines
cell.references
cell.outputs
cell.output
cell.runtime_outputs
```

These properties read from `cell.info` and return empty tuples or `None` before
the graph is available.

## Cell Helpers

| Helper | Cell mode |
| --- | --- |
| `obs.ojs(source, ...)` | Observable JavaScript |
| `obs.js(source, ...)` | ES module JavaScript |
| `obs.md(source, ...)` | Markdown |
| `obs.html(source, ...)` | HTML |

```python
obs.ojs(
    source,
    name=None,
    display=True,
    raw=False,
    id=None,
    pinned=False,
    output=None,
    attrs=None,
)
```

`obs.ojs(...)` returns a source `Cell` and accepts:

- `name`: a stable Python name for `notebook.cell(...)`.
- `display`: whether to render the cell output.
- `raw`: whether to preserve source whitespace exactly.
- `id`: Notebook Kit cell id override.
- `pinned`: whether Notebook Kit should treat the source as pinned.
- `output`: Notebook Kit output attribute.
- `attrs`: additional Notebook Kit script attributes for advanced cases.

Mode-specific helpers such as `obs.md(...)` and `obs.html(...)` accept the same
keywords except `mode`. Helper source strings are dedented and stripped of
leading/trailing newlines unless `raw=True`.

Use `obs.js(...)` when you need an ES module cell:

```python
obs.Notebook(
    obs.js(
        "const answer = 42",
        output="answer",
    ),
    obs.ojs("answer"),
)
```

Use `obs.ojs(...)` for ordinary Observable cells.

## Python Variables

`variables` accepts a mapping from JavaScript identifier names to serializable Python
values.

Supported values include:

- `None`, booleans, strings, integers, finite floats, `NaN`, and infinities
- lists, tuples, ranges, iterables, and nested dictionaries
- `datetime.date` and `datetime.datetime`
- bytes-like values
- NumPy scalar and array values through `item()` or `tolist()`
- pandas and Polars series as lists
- pandas and Polars dataframes as records

Dataframes are serialized as row dictionaries.

## Graph Metadata

Graph metadata is populated after the browser renders and transpiles the
notebook:

```python
graph = notebook.graph
```

Before the first browser render, `notebook.graph` is `None`.

`graph` is a `NotebookGraph` with:

- `cells`: `CellInfo` entries in notebook order
- `edges`: cell-id-to-cell-id dependencies by variable
- `defines`: all Python-visible variables defined by notebook cells
- `references`: all variables referenced by notebook cells
- `external_references`: referenced names outside notebook cell definitions

Each `DependencyEdge` has `source_id`, `target_id`, and `variable`.

Each `CellInfo` has:

- `defines`: Python-visible variables exposed by that cell
- `references`: variables read by that cell
- `output`: Notebook Kit's raw singular runtime output, if present
- `outputs`: Notebook Kit's raw plural output declarations
- `runtime_outputs`: raw runtime names used when building dependency edges
- `autodisplay`, `autoview`, and `automutable`
- `error`: Notebook Kit transpilation error, when present

The matching cell widget exposes the same metadata:

```python
cell = notebook.cell("gain")
cell.info
cell.defines
cell.references
cell.runtime_outputs
```

Use `notebook.cell_for_variable("gain")` to select the cell that defines the
Observable variable `gain`.
