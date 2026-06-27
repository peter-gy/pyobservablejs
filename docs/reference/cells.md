---
title: Cells
description: Cell helper function signatures and options.
---

# Cells

All cell helpers share the same signature.

```python
obs.ojs(source, *, key=None, display=True, raw=False, id=None, pinned=False, output=None, notebookkit_attrs=None)
obs.js(source, *, key=None, display=True, raw=False, id=None, pinned=False, output=None, notebookkit_attrs=None)
obs.md(source, *, key=None, display=True, raw=False, id=None, pinned=False, output=None, notebookkit_attrs=None)
obs.html(source, *, key=None, display=True, raw=False, id=None, pinned=False, output=None, notebookkit_attrs=None)
```

Each helper returns a `Cell` object consumed by `obs.Notebook`.

```python
notebook = obs.Notebook(
    obs.md("# Report"),
    obs.ojs("total = rows.length", key="total", display=False),
    obs.html("<p>Rendered in Notebook Kit</p>"),
    variables={"rows": [{"x": 1}, {"x": 2}]},
)
```

## Arguments

`source` must be a string or an existing `Cell`. String source is dedented and
stripped of leading and trailing newlines unless `raw=True`.

`key` sets the Python `NotebookCell` handle. It does not serialize to Notebook
Kit HTML and does not rename variables defined in the Observable source.

`display=False` hides the cell output.

`id` sets the Notebook Kit cell id.

`pinned=True` marks the source for the source panel when the parent notebook has
`show_pinned_source=True`.

`output` sets the Notebook Kit output attribute.

`notebookkit_attrs` passes additional Notebook Kit cell attributes, including
Notebook Kit `name` when source compatibility requires it. It cannot set
attributes that already have first-class helper options, such as `id`, `output`,
or `hidden`.

## Existing cells

Passing an existing `Cell` through another helper is allowed only when no
options are changed.

```python
cell = obs.ojs("answer = 42")
same_cell = obs.ojs(cell)
```

Changing options on an existing `Cell` raises `TypeError`.
