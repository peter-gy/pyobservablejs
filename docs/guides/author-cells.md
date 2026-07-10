---
title: Observable cells and reactivity
description: Author Notebook Kit cells and connect them through the reactive graph.
---

# Observable cells and reactivity

`obs.js` creates a standard JavaScript cell. Use top-level declarations to
share values with other cells. Try moving the exponent control. The readout
recomputes in the browser.

```{marimo-config}
:pyproject:

  requires-python = ">=3.11"
  dependencies = [
      "pyobservablejs",
  ]
```

```{marimo} python
:echo: true

import marimo as mo
import observablejs as obs

notebook = obs.Notebook(
    obs.js(
        """
        const exponent = view(Inputs.range(
          [1, 8],
          {label: "Exponent", step: 1, value: 2}
        ));
        """,
        key="exponent_control",
    ),
    obs.js(
        'html`<p>Two to the power of ${exponent} is <strong>${2 ** exponent}</strong>.</p>`',
        key="readout",
    ),
)

mo.ui.anywidget(notebook)
```

The first cell defines `exponent`. The readout references it, so Notebook Kit
runs that cell again when the input changes. Notebook Kit schedules cells from
their dependencies, independent of source order.

## JavaScript cells

An expression cell displays its value implicitly.

```python
obs.js("Plot.lineY(aapl, {x: 'Date', y: 'Close'}).plot()")
```

A program cell contains declarations or statements. Call `display(...)` when a
program cell should render an additional value.

```python
obs.js(
    """
    const formatter = new Intl.NumberFormat("en-US");
    display(formatter.format(42000));
    """
)
```

`view(...)` displays an input and defines a reactive value from its events.

```python
obs.js(
    'const radius = view(Inputs.range([2, 12], {value: 5, label: "Radius"}));'
)
```

## Observable JavaScript cells

`obs.ojs` creates a classic Observable JavaScript cell. Use it for existing OJS
source, `viewof` declarations, and imported Observable notebook code.

```python
obs.ojs(
    'viewof radius = Inputs.range([2, 12], {value: 5, label: "Radius"})'
)
```

Both cell modes participate in the same Notebook Kit graph.

## Markdown and HTML cells

`obs.md` renders Markdown. `obs.html` renders HTML.

```python
notebook = obs.Notebook(
    obs.md("## Filtered records"),
    obs.html("<p><strong>Status:</strong> loaded</p>"),
)
```

## Cell options

Every helper accepts the same options.

```python
obs.js(
    "const filtered = rows.filter((d) => d.value >= threshold);",
    key="filtered_rows",
    display=False,
    pinned=True,
    output="filtered",
)
```

`key` names the Python `NotebookCell` handle. `display=False` hides the cell
output while keeping its values in the graph. `pinned=True` exposes the source
when the notebook enables `show_pinned_source`. `raw=True` preserves leading
and trailing newlines.

See [Cells](../reference/cells.md) for the complete signature and error
behavior.
