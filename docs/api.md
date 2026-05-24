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

Use `Notebook` to create a widget from Python-authored cells.

Common arguments:

- `*cells`: strings or `Cell` objects.
- `title`: notebook title used when exporting to Notebook Kit HTML.
- `theme`: Notebook Kit theme, usually `"air"`.
- `mode`: default mode for plain string cells.
- `attachments`: mapping from `FileAttachment` names to paths, URLs, or metadata.
- `base_path`: base path for relative attachment inputs.
- `data`: Python values exposed as OJS variables.
- `show_pinned_source`: render source for pinned cells.

Useful attributes and methods:

```python
notebook.data
notebook.data = {"rows": rows}
notebook.cells
notebook.cell("name")
notebook.values
notebook.value("name")
notebook.to_notebook_html()
```

## Cell Helpers

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

`ojs.arrow(df)` requires `pyarrow` and sends Arrow IPC to the browser.

## Source-backed Notebooks

```python
ojs.Notebook.from_file(
    path,
    portable=True,
    data=None,
    attachments=None,
    show_pinned_source=False,
)
```

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

Use these when you already have Notebook Kit HTML. With `portable=True`, local
attachments and relative JavaScript imports are embedded.

## Cell Values

Cell values are populated after the browser renders and evaluates the notebook.

```python
notebook = ojs.Notebook(
    ojs.cell("answer = 42", name="answer"),
)

notebook.cell("answer").value
notebook.value("answer")
```

For `viewof` cells, the synchronized value is the current input value, not the DOM
element.
