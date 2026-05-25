---
title: API
description: Public Python API reference for observablejs.
---

# API

Import the package as `ojs`:

```python
import observablejs as ojs
```

## Notebook

```python
ojs.Notebook(
    *cells,
    title="Untitled",
    theme="air",
    mode="ojs",
    attachments=None,
    base_path=None,
    data=None,
    show_pinned_source=False,
)
```

Create an anywidget model from Python-authored cells. Displaying the notebook in
a compatible frontend renders the cells with the Observable Notebook Kit browser
runtime.

- `*cells`: strings or `Cell` objects.
- `title`: title written to exported Notebook Kit HTML.
- `theme`: Notebook Kit theme, usually `"air"`.
- `mode`: default mode for plain string cells.
- `attachments`: mapping from `FileAttachment` names to paths, URLs, or metadata.
- `base_path`: base path for relative attachment inputs.
- `data`: Python values exposed as OJS variables. Matching notebook variables
  are overridden.
- `show_pinned_source`: render source for pinned cells.

Plain string cells use `mode="ojs"` by default.

Browser-populated fields such as `values`, `graph`, and cell metadata are empty
until the widget has rendered.

### `Notebook.data`

```python
notebook.data
notebook.data = {"rows": rows}
notebook.update_data(rows=rows, floor=0.04)
```

Returns the Python mapping currently exposed to the Observable runtime. Assigning
a new mapping updates the synced widget trait. TypeScript revives the values as
Observable builtins and redefines matching notebook variables so dependent cells
settle on the Python-provided values.

`update_data` merges new keys into the current mapping before syncing the trait.
Use it when a stable notebook should receive Python-side state changes from a
notebook host such as marimo or Jupyter.

When assignment removes keys, the browser rebuilds the runtime to restore the
notebook's original definitions for those names.

### `Notebook.cells`

```python
notebook.cells
```

Tuple of `CellHandle` objects in notebook order. Each Notebook Kit cell has one
handle.

### `Notebook.cell`

```python
notebook.cell(key)
```

Return a `CellHandle` by zero-based index, handle name, or unique Observable
variable defined by a cell. Ambiguous handle names or variable names raise
`KeyError`.

### `Notebook.defining_cell`

```python
notebook.defining_cell(name)
```

Return the unique `CellHandle` whose graph metadata defines the Observable
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
ojs.Notebook.from_file(
    path,
    portable=True,
    data=None,
    attachments=None,
    show_pinned_source=False,
)
```

Load Notebook Kit HTML from disk. With `portable=True`, local
`FileAttachment(...)` references and relative JavaScript imports are embedded.
Pass `data={...}` to set or override OJS variables.

### `Notebook.from_html`

```python
ojs.Notebook.from_html(
    source,
    portable=True,
    data=None,
    attachments=None,
    base_path=None,
    show_pinned_source=False,
)
```

Create a source-backed notebook from an HTML string. `base_path` is used to
resolve local attachments and imports when `portable=True`. Pass `data={...}` to
set or override OJS variables.

### `Notebook.from_url`

```python
ojs.Notebook.from_url(
    url,
    data=None,
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
same name. Pass `data={...}` to set or override variables in the loaded
notebook.

## CellHandle

`CellHandle` is the child anywidget model for one Observable cell. Users usually
obtain handles with `notebook.cell(...)`.

### `CellHandle.value`

```python
notebook.cell("gain").value
```

Return the resolved current value for the cell. If the handle name appears in
its synced values, that value is returned. If the cell exposes exactly one value,
that value is returned. Otherwise the full values dictionary is returned.

### `CellHandle.values`

```python
notebook.cell("gain").values
```

Return all browser-synchronized values exposed by the cell.

### `CellHandle.info`

```python
notebook.cell("gain").info
```

Return the matching `CellInfo`, or `None` before graph metadata is available.

### Cell metadata shortcuts

```python
handle.defines
handle.references
handle.inputs
handle.outputs
handle.output
handle.runtime_outputs
```

These properties read from `handle.info` and return empty tuples or `None` before
the graph is available.

## Cell Helpers

| Helper | Cell mode |
| --- | --- |
| `ojs.cell(source, ...)` | Observable JavaScript |
| `ojs.module(source, ...)` | ES module JavaScript |
| `ojs.md(source, ...)` | Markdown |
| `ojs.html(source, ...)` | HTML |
| `ojs.sql(source, ...)` | SQL |

```python
ojs.cell(source, name=None, display=True, mode="ojs", raw=False, attrs=None)
```

`ojs.cell(...)` accepts:

- `name`: a stable name for Python cell handles.
- `display`: whether to render the cell output.
- `mode`: Notebook Kit script mode for this cell.
- `raw`: whether to preserve source whitespace exactly.
- `attrs`: Notebook Kit script attributes such as `output`, `database`, or
  `format`.

Mode-specific helpers such as `ojs.md(...)` and `ojs.sql(...)` accept the same
keywords except `mode`. Helper source strings are dedented and stripped of
leading/trailing newlines unless `raw=True`.

Use `ojs.module(...)` when you need an ES module cell:

```python
ojs.Notebook(
    ojs.module(
        "const answer = 42",
        attrs={"output": "answer"},
    ),
    ojs.cell("answer"),
)
```

Use `ojs.cell(...)` for ordinary Observable cells.

## Python Data

`data` accepts a mapping from JavaScript identifier names to serializable Python
values.

Supported values include:

- `None`, booleans, strings, integers, finite floats, `NaN`, and infinities
- lists, tuples, ranges, iterables, and nested dictionaries
- `datetime.date` and `datetime.datetime`
- bytes-like values
- NumPy scalar and array values through `item()` or `tolist()`
- pandas and Polars series as lists
- pandas and Polars dataframes as records

Use these helpers to choose dataframe transport explicitly:

```python
ojs.records(df)
ojs.arrow(df)
```

`ojs.records(df)` sends dataframe-like values as row dictionaries. `ojs.arrow(df)`
requires `pyarrow` and sends Arrow IPC to the browser.

## Graph Metadata

Graph metadata is populated after the browser renders and transpiles the
notebook:

```python
graph = notebook.graph
```

Before the first browser render, `notebook.graph` is `None`.

`graph` is a `NotebookGraph` with:

- `cells`: `CellInfo` entries in notebook order
- `edges`: cell-id-to-cell-id dependencies by runtime variable name
- `defines`: all Python-visible variables defined by notebook cells
- `references`: all variables referenced by notebook cells
- `external_references`: referenced names outside notebook cell definitions

Each `DependencyEdge` has `source_id`, `target_id`, and `name`.

Each `CellInfo` has:

- `defines`: Python-visible variables exposed by that cell
- `references` / `inputs`: variables read by that cell
- `output`: Notebook Kit's raw singular runtime output, if present
- `outputs`: Notebook Kit's raw plural output declarations
- `runtime_outputs`: raw runtime names used when building dependency edges
- `autodisplay`, `autoview`, and `automutable`
- `error`: Notebook Kit transpilation error, when present

The matching cell handle exposes the same metadata:

```python
handle = notebook.cell("gain")
handle.info
handle.defines
handle.references
handle.runtime_outputs
```

Use `notebook.defining_cell("gain")` to select the cell that defines the
Observable variable `gain`.
