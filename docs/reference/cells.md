---
title: Cells
description: Cell data model and helper function contracts.
---

# Cells

`Cell` describes one Notebook Kit cell. The `ojs`, `js`, `md`, and `html`
helpers create cells in the modes used most often by Python-authored notebooks.

```python
import observablejs as obs

notebook = obs.Notebook(
    obs.md("# Report"),
    obs.ojs("total = rows.length", key="total", display=False),
    obs.html("<p>Rendered in Notebook Kit</p>"),
    variables={"rows": [{"x": 1}, {"x": 2}]},
)
```

## `Cell`

```python
obs.Cell(
    source,
    mode="ojs",
    key=None,
    name=None,
    display=True,
    raw=False,
    notebookkit_attrs={},
)
```

Creates a frozen data-class record. `Notebook` converts each `Cell` to a
Notebook Kit cell spec during construction.

| Argument            | Default       | Contract                                                                                                                |
| ------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `source`            | Required      | Source string for the cell.                                                                                             |
| `mode`              | `"ojs"`       | Notebook Kit mode. Accepted values are `js`, `ts`, `ojs`, `md`, `html`, `tex`, `dot`, `sql`, `node`, `python`, and `r`. |
| `key`               | `None`        | Python handle used by `Notebook.cell_by_key`. The key stays outside serialized Notebook Kit HTML.                       |
| `name`              | `None`        | Notebook Kit cell name written to serialized HTML.                                                                      |
| `display`           | `True`        | Controls the Notebook Kit `hidden` attribute.                                                                           |
| `raw`               | `False`       | Preserves source indentation and surrounding newlines when true.                                                        |
| `notebookkit_attrs` | Empty mapping | Notebook Kit cell attributes applied after the direct fields when the generated spec is built.                          |

With `raw=False`, construction applies `textwrap.dedent` and strips leading and
trailing newline characters. A non-string `source` raises `TypeError`. An
unknown `mode` raises `ValueError` when the cell is converted to a spec, which
happens during `Notebook` construction.

### `Cell.to_spec(id)`

```python
spec = cell.to_spec(1)
```

Returns a new Notebook Kit cell dictionary. `notebookkit_attrs` takes
precedence when it contains a key also set by a direct `Cell` field. Its `id`
takes precedence over the method's `id`. `key` remains a Python handle and is
excluded from the returned dictionary.

## Cell helpers

```python
obs.ojs(source, *, key=None, display=True, raw=False, id=None, pinned=False, output=None, notebookkit_attrs=None)
obs.js(source, *, key=None, display=True, raw=False, id=None, pinned=False, output=None, notebookkit_attrs=None)
obs.md(source, *, key=None, display=True, raw=False, id=None, pinned=False, output=None, notebookkit_attrs=None)
obs.html(source, *, key=None, display=True, raw=False, id=None, pinned=False, output=None, notebookkit_attrs=None)
```

Each helper returns a `Cell` with a fixed mode:

| Helper | Mode   | Source semantics      |
| ------ | ------ | --------------------- |
| `ojs`  | `ojs`  | Observable JavaScript |
| `js`   | `js`   | JavaScript module     |
| `md`   | `md`   | Markdown              |
| `html` | `html` | HTML                  |

The keyword arguments have the following contracts:

- `key` sets the Python `NotebookCell` selection handle. Observable variable
  names come from the cell source.
- `display=False` emits the Notebook Kit `hidden` attribute.
- `raw=True` preserves the source string exactly.
- `id` sets the Notebook Kit cell id. `Notebook` assigns one-based ids in
  notebook order when it is omitted.
- `pinned=True` emits the Notebook Kit `pinned` attribute. Active views render
  pinned source when `show_pinned_source=True`.
- `output` sets the Notebook Kit `output` attribute.
- `notebookkit_attrs` adds Notebook Kit attributes such as `name`, `database`,
  or `format`.

`notebookkit_attrs` raises `ValueError` when it contains `hidden`, `id`, `mode`,
`output`, `pinned`, or `value`. Use the corresponding helper argument for the
first-class options.

## Existing cells

A helper returns an existing `Cell` unchanged when its mode matches and every
option remains at its default.

```python
cell = obs.ojs("answer = 42")
same_cell = obs.ojs(cell)

assert same_cell is cell
```

Changing the mode or any option on an existing `Cell` raises `TypeError`.
