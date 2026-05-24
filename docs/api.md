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
- `data`: Python values exposed as OJS variables.
- `show_pinned_source`: render source for pinned cells.

Plain string cells use `mode="ojs"` by default.

### `Notebook.data`

```python
notebook.data
notebook.data = {"rows": rows}
```

Returns the Python mapping currently exposed to the Observable runtime. Assigning
a new mapping updates the synced widget trait; the browser revives the values as
runtime builtins before cells recompute.

### `Notebook.cells`

```python
notebook.cells
```

Tuple of `CellHandle` objects in notebook order. There is one handle for every
Notebook Kit cell.

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

Return `notebook.values[name]`. This is useful for reading a single `viewof`
input or computed cell value after browser evaluation.

For `viewof` cells, synchronized values are the current input values, not DOM
elements.

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

Return Notebook Kit HTML. Python-authored notebooks are serialized from `spec`;
source-backed notebooks return their original HTML source.

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
resolve local attachments and imports when `portable=True`.

## CellHandle

`CellHandle` is the child anywidget model for one Observable cell. Users usually
obtain handles with `notebook.cell(...)`.

### `CellHandle.value`

```python
notebook.cell("gain").value
```

Return the most convenient current value for the cell. If the handle name appears
in its synced values, that value is returned. If the cell exposes exactly one
value, that value is returned. Otherwise the full values dictionary is returned.

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

```python
ojs.cell(source, name=None, display=True, raw=False, attrs=None)
```

| Helper | Cell mode |
| --- | --- |
| `ojs.cell(source, ...)` | Observable JavaScript |
| `ojs.module(source, ...)` | ES module JavaScript |
| `ojs.md(source, ...)` | Markdown |
| `ojs.html(source, ...)` | HTML |
| `ojs.sql(source, ...)` | SQL |

All helpers accept:

- `name`: a stable name for Python cell handles.
- `display`: whether to render the cell output.
- `raw`: whether to preserve source whitespace exactly.
- `attrs`: Notebook Kit script attributes such as `output`, `database`, or
  `format`.

Helper source strings are dedented and stripped of leading/trailing newlines
unless `raw=True`.

Use `ojs.module(...)` when you need an ES module cell:

```python
ojs.Notebook(
    ojs.module(
        "const answer = 42;",
        attrs={"output": "answer"},
    ),
    ojs.cell("answer"),
)
```

Most notebooks should use `ojs.cell(...)`.

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

Use helpers to choose dataframe transport explicitly:

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
- `external_references`: referenced names not defined by another cell

Each `DependencyEdge` has `source_id`, `target_id`, and `name`.

Each `CellInfo` has:

- `defines`: Python-visible variables exposed by that cell
- `references` / `inputs`: variables read by that cell
- `output`: Notebook Kit's raw singular runtime output, if present
- `outputs`: Notebook Kit's raw plural output declarations
- `runtime_outputs`: raw runtime names used when building dependency edges
- `autodisplay`, `autoview`, and `automutable`
- `error`, if Notebook Kit could not transpile that cell

The matching cell handle exposes the same metadata:

```python
handle = notebook.cell("gain")
handle.info
handle.defines
handle.references
handle.runtime_outputs
```

Use `notebook.defining_cell("gain")` when you want the cell that defines an
Observable variable rather than a Python handle name.
