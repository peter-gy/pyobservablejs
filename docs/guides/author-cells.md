---
title: Author cells
description: Create Observable, JavaScript, Markdown, and HTML cells from Python.
---

# Author cells

`obs.Notebook` accepts cells created by `obs.ojs`, `obs.js`, `obs.md`, and
`obs.html`. Each helper names the source mode at the call site.

```python
import observablejs as obs

notebook = obs.Notebook(
    obs.md("# Revenue"),
    obs.ojs("total = rows.reduce((sum, d) => sum + d.revenue, 0)", key="total"),
    obs.ojs("md`Total revenue: **${total}**`", key="readout"),
    variables={"rows": [{"revenue": 42}, {"revenue": 31}]},
)
```

## Helper functions

### `obs.ojs(source, ...)`

Creates an Observable JavaScript cell. Use it for reactive definitions,
`viewof` inputs, Plot charts, and Notebook Kit standard library calls.

```python
obs.ojs(
    'viewof region = Inputs.select(["west", "east"], {label: "region"})',
    key="region_control",
)
```

### `obs.js(source, ...)`

Creates a JavaScript module cell. Use it for standard JavaScript where
Observable cell syntax is not desired.

```python
obs.js(
    """
    const formatter = new Intl.NumberFormat("en-US")
    export {formatter}
    """,
    key="formatters",
)
```

### `obs.md(source, ...)`

Creates a Markdown cell.

```python
obs.md("## Filtered records")
```

### `obs.html(source, ...)`

Creates an HTML cell.

```python
obs.html("<p><strong>Status:</strong> loaded</p>")
```

## Cell options

Every helper accepts the same keyword arguments.

```python
obs.ojs(
    "hiddenTotal = rows.length",
    key="hidden_total",
    display=False,
    pinned=True,
    output="hiddenTotal",
)
```

`name` names the Python `NotebookCell` handle. The Observable variables are
still defined by the source code. `display=False` hides the cell output.
`pinned=True` marks the cell for the source panel when
`show_pinned_source=True`. `raw=True` preserves leading and trailing newlines.

Existing `Cell` objects cannot be overridden by another helper call. Create a
new helper call instead.
