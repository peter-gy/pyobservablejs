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
- `attachments`: mapping from `FileAttachment` names to local paths, URLs, or
  metadata. Local paths resolve against `base_path` or the current working
  directory and are read during construction. URL strings and metadata mappings
  are not read locally.
- `base_path`: base path for relative attachments.
- `variables`: Python values exposed as OJS variables. Matching notebook variables
  are overridden.
- `show_pinned_source`: render source for pinned cells.

Plain string cells use `mode="ojs"` by default.

Raises:

- `ValueError`: `mode` or a variable name is invalid.
- `TypeError`: a cell is not a string or `Cell`, or a variable value cannot be
  serialized.
- `FileNotFoundError` or `OSError`: an explicit local attachment path is missing
  or unreadable.

Browser-populated fields such as `values`, `graph`, and cell metadata are empty
until the widget has rendered.

### `Notebook.variables`

```python
notebook.variables
```

Return a copy of the current Python-owned variable environment exposed to OJS.
Matching notebook variables use the Python-provided values.

### `Notebook.update_variables`

```python
notebook.update_variables(rows=rows, floor=0.04)
notebook.update_variables({"rows": rows})
```

Merge keys into the current Python-owned environment and sync a live update to
the browser. Existing Python-owned keys that are not mentioned stay unchanged.

- `values`: mapping or iterable of key/value pairs.
- `**kwargs`: extra variable updates merged after `values`.
- Returns `None`.
- Empty input leaves the widget traits unchanged.
- Raises `TypeError` when `values` is not a mapping or key/value iterable.
- Raises `ValueError` when a variable name is not a JavaScript identifier.
- Raises `TypeError` when a value cannot be serialized.

### `Notebook.replace_variables`

```python
notebook.replace_variables({"rows": rows})
notebook.replace_variables(rows=rows)
```

Replace the full Python-owned environment and sync a live replacement to the
browser. Keys omitted from the replacement are released. The browser rebuilds the
runtime so the notebook's original definitions return for those names.

- `values`: mapping or iterable of key/value pairs.
- `**kwargs`: extra variable values merged after `values`.
- Returns `None`.
- Raises `TypeError` when `values` is not a mapping or key/value iterable.
- Raises `ValueError` when a variable name is not a JavaScript identifier.
- Raises `TypeError` when a value cannot be serialized.

### `Notebook.reset_variables`

```python
notebook.reset_variables(*names)
```

Release one or more Python-owned variables. Missing names and empty calls are
no-ops. When a reset removes a key, the browser receives a replacement update and
restores the notebook's original definition for that name.

- `*names`: Python-owned variable names to release.
- Returns `None`.
- Sends a browser replacement update only when at least one owned name is
  removed.

### `Notebook.cells`

```python
notebook.cells
```

Tuple of `NotebookCell` widgets in notebook order. Each Notebook Kit cell has one
child widget. After the parent notebook has rendered, display a child widget to
render that cell in a standalone output root.

```python
notebook.cells[1]
```

Before the parent render, the child widget has no runtime context. The
standalone output has its own browser runtime. DOM outputs render as DOM in that
output root, while `NotebookCell.values` still contains only synchronized
JSON-compatible values.

### `Notebook.cell`

```python
notebook.cell(key)
```

Return a `NotebookCell` by zero-based index or Python name. Ambiguous or
unknown names raise `KeyError`.

- Integer keys use tuple indexing, so negative indexes are allowed.
- Out-of-range integer keys raise `IndexError`.
- String keys match `name=` values on child cells.
- Unknown or ambiguous names raise `KeyError`.

### `Notebook.cell_for_variable`

```python
notebook.cell_for_variable(name)
```

Return the unique `NotebookCell` whose rendered graph metadata defines the
Observable variable `name`. The graph is available after the browser renders the
notebook. Before render, unknown names, and ambiguous definitions raise
`KeyError`.

### `Notebook.values`

```python
notebook.values
```

Dictionary of the latest browser-synchronized values for named cells and exposed
variables. Before the first browser render, this may be empty.

Values cross as JSON-compatible trait state. Browser-only objects are summarized:
DOM elements become tag names, functions become function labels, files and blobs
become metadata dictionaries, and typed arrays or array buffers become bytes.

### `Notebook.value`

```python
notebook.value(name)
```

Return the synchronized value for `name`. When graph metadata exists, this first
reads the cell that defines `name`. It falls back to `notebook.values[name]`.
Missing or unsynchronized names raise `KeyError`.

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

### `Notebook.from_html`

```python
obs.Notebook.from_html(
    source,
    attachments=None,
    base_path=None,
    portable=True,
    variables=None,
    show_pinned_source=False,
)
```

Create a source-backed notebook from a Notebook Kit HTML string. Load the HTML
string before calling this method.

- `source`: Notebook Kit HTML string. Non-string values raise `TypeError`.
- `base_path`: base directory for local `FileAttachment(...)` references,
  relative imports, and explicit relative `attachments`.
- `portable`: defaults to `True`. When `portable=True` and `base_path` is set,
  local file attachments are embedded and relative JavaScript imports are
  rewritten to data URLs.
- `attachments`: explicit attachment mapping. These entries override discovered
  attachments with the same name. Local paths resolve against `base_path` or the
  current working directory and are read before browser render. URL strings and
  metadata mappings are not read locally.
- `variables`: Python-owned OJS variables. Invalid names raise `ValueError`.
  Unsupported values raise `TypeError`.
- `show_pinned_source`: render Notebook Kit pinned source panels in cell widgets.
- Raises `FileNotFoundError` or `OSError` when an explicit local attachment path
  is missing or unreadable.

### `Notebook.from_observablehq`

```python
obs.Notebook.from_observablehq(
    specifier,
    variables=None,
    attachments=None,
    show_pinned_source=False,
    timeout=30,
)
```

Load a public ObservableHQ notebook through the document API.

- `specifier`: full ObservableHQ URL, slug such as `@mbostock/saving-svg`,
  16-character notebook id, or ObservableHQ document API URL.
- `timeout`: request timeout in seconds. Defaults to `30`. Pass `None` to use the
  urllib default.
- Performs network I/O against `api.observablehq.com`.
- Only public notebooks can be fetched.
- ObservableHQ API `js` nodes are converted to Notebook Kit `ojs` cells.
- Hosted markdown tags such as ``md`** 1. Title**` `` use ObservableHQ
  compatibility during render. This compatibility is scoped to
  `from_observablehq`. `from_html` and Python-authored cells keep Notebook Kit's
  normal markdown contract.
- Uploaded files become URL-backed `FileAttachment` entries.
- Explicit `attachments` override discovered remote attachments with the same
  name. They may be local paths, URL strings, or metadata mappings. Local paths
  resolve against the current working directory and are read before browser
  render. URL strings and metadata mappings are not read locally.
- `variables` sets or overrides variables in the loaded notebook.
- Raises `ValueError` for invalid specifiers or non-JSON document responses.
- Raises `OSError` for HTTP and network failures.
- Raises `FileNotFoundError` or `OSError` when an explicit local attachment path
  is missing or unreadable.

## NotebookCell

`NotebookCell` is the child anywidget model for one rendered Observable cell.
Users usually obtain cell widgets with `notebook.cell(...)`.

### `NotebookCell.value`

```python
notebook.cell("gain").value
```

Return the cell's browser-synchronized value when it is unambiguous. Use
`notebook.cell("gain").values["gain"]` for explicit named access.

Resolution order:

1. Return `cell.values[cell.name]` when the named cell has a synchronized value.
2. Return the only synchronized value when the cell exposes exactly one value.
3. Raise `KeyError` before render, when no value exists, or when multiple unnamed
   values exist.

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

| Helper                  | Cell mode             |
| ----------------------- | --------------------- |
| `obs.ojs(source, ...)`  | Observable JavaScript |
| `obs.js(source, ...)`   | ES module JavaScript  |
| `obs.md(source, ...)`   | Markdown              |
| `obs.html(source, ...)` | HTML                  |

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

The helper signatures are shared:

```python
obs.ojs(source, *, name=None, display=True, raw=False, id=None, pinned=False, output=None, attrs=None)
obs.js(source, *, name=None, display=True, raw=False, id=None, pinned=False, output=None, attrs=None)
obs.md(source, *, name=None, display=True, raw=False, id=None, pinned=False, output=None, attrs=None)
obs.html(source, *, name=None, display=True, raw=False, id=None, pinned=False, output=None, attrs=None)
```

Each helper returns a source `Cell` and accepts:

- `source`: a string, or an existing `Cell` with no override arguments.
- `name`: a stable Python name for `notebook.cell(...)`.
- `display`: whether to render the cell output.
- `raw`: whether to preserve source whitespace exactly.
- `id`: Notebook Kit cell id override.
- `pinned`: whether Notebook Kit should treat the source as pinned.
- `output`: Notebook Kit output attribute.
- `attrs`: attributes copied into the Notebook Kit cell spec. `id`, `pinned`, and
  `output` helper arguments override matching `attrs` keys before the final cell
  is built.
- Raises `TypeError` when `source` is not a string or `Cell`, or when override
  arguments are passed with an existing `Cell`.

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

`variables` must be a mapping from JavaScript identifier names to serializable
Python values. Names must match `[A-Za-z_$][0-9A-Za-z_$]*`. Invalid names raise
`ValueError`. Unsupported values raise `TypeError`.

Supported values include:

- `None`, booleans, strings, integers, finite floats, `NaN`, and infinities
- lists, tuples, ranges, iterables, and nested dictionaries
- `datetime.date` and `datetime.datetime`
- bytes-like values
- NumPy scalar and array values through `item()` or `tolist()`
- pandas and Polars series as lists
- pandas and Polars dataframes as row dictionaries

Mappings containing `__pyobservablejs_type__` are escaped as ordinary objects so
user data cannot be mistaken for the internal wire tags.

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
