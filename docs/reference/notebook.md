---
title: Notebook
description: obs.Notebook constructor and methods.
---

# `Notebook`

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

Creates an anywidget model for an Observable Notebook Kit notebook.

```python
import observablejs as obs

notebook = obs.Notebook(
    obs.md("# Summary"),
    obs.ojs("answer = 40 + 2", key="answer"),
    obs.ojs("md`Answer: **${answer}**`"),
)
```

## Arguments

`*cells` accepts `Cell` objects created by `obs.ojs`, `obs.js`, `obs.md`, and
`obs.html`.

`title` becomes the Notebook Kit document title for Python-authored notebooks.

`theme` accepts a theme name or `{"light": name, "dark": name}`.

`files` registers Python file inputs. Local paths are resolved against
`base_path` when provided. Observable code reads them with `FileAttachment`.

`variables` sets Python-owned Observable variables.

`show_pinned_source=True` renders pinned source cells in the Notebook Kit source
panel.

## Variable methods

```python
notebook.variables
notebook.update_variables({"minimum": 5})
notebook.update_variables(minimum=5)
notebook.replace_variables({"rows": rows})
notebook.reset_variables("minimum")
```

`variables` returns a copy of the Python-owned environment.

`update_variables` merges updates into that environment and patches the live
runtime when the widget is displayed.

`replace_variables` replaces the whole environment. Names omitted from the
replacement are released.

`reset_variables` releases named variables if Python currently owns them.

## Cells and values

```python
notebook.cells
notebook.cell_at(0)
notebook.cell_by_key("answer")
notebook.cell_for_variable("answer")
notebook.runtime_values
notebook.cell_values()
notebook.value("answer")
notebook.graph
```

Values and graph metadata are browser-synchronized. `notebook.graph` is
available after graph metadata syncs from either a full notebook display or a
direct `NotebookCell` display. `notebook.runtime_values`,
`notebook.cell_values()`, and `notebook.value(name)` require a full notebook
render. These readback APIs raise `NotRenderedError` before their lifecycle
state is available.

## Source output

```python
html = notebook.to_notebook_html()
```

For Python-authored notebooks, this returns serialized Notebook Kit HTML. For
source-backed notebooks, it returns the original source after explicit file or
import rewrites.

## Errors

`Notebook` raises `ValueError` for unsupported modes, invalid variable names,
reserved runtime names, duplicate cell keys, and unsupported themes. It raises
`TypeError` for unsupported cell or variable values. Local files can raise
`FileNotFoundError` or `OSError`.
