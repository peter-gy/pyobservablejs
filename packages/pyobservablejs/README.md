# pyobservablejs

[![CI](https://github.com/peter-gy/pyobservablejs/actions/workflows/ci.yml/badge.svg)](https://github.com/peter-gy/pyobservablejs/actions/workflows/ci.yml)
[![PyPI](https://img.shields.io/pypi/v/pyobservablejs.svg)](https://pypi.org/project/pyobservablejs/)
[![Python versions](https://img.shields.io/pypi/pyversions/pyobservablejs.svg)](https://pypi.org/project/pyobservablejs/)
[![License](https://img.shields.io/pypi/l/pyobservablejs.svg)](https://github.com/peter-gy/pyobservablejs/blob/main/LICENSE)

`pyobservablejs` brings interactive Observable notebooks into Python workflows.
Author a notebook in Python or load an existing one, render the views you need,
and keep its controls and results connected to your Python code.

Use it in JupyterLab, marimo, VS Code notebooks, Google Colab, and other
environments that support [anywidget](https://anywidget.dev/).

## Quick start

Python 3.11 or newer is required.

```sh
uv add pyobservablejs marimo
uv run marimo edit notebook.py
```

### Existing Observable notebook

```python
import marimo as mo
import observablejs as obs

notebook = obs.Notebook.from_observablehq("@d3/world-tour")
mo.ui.anywidget(notebook.view())
```

`@d3/world-tour` resolves to
[observablehq.com/@d3/world-tour](https://observablehq.com/@d3/world-tour).

### Author an interactive notebook

```python
import marimo as mo
import observablejs as obs

notebook = obs.Notebook(
    obs.html(
        """
        <h2>Palmer penguins</h2>
        <p>Choose a species to filter the chart.</p>
        """
    ),
    obs.ojs(
        """
        viewof species = Inputs.select(
          ["All", ...new Set(penguins.map((d) => d.species))],
          {label: "Species", value: "All"}
        )
        """,
        key="species_control",
    ),
    obs.js(
        """
        Plot.dot(
          species === "All"
            ? penguins
            : penguins.filter((d) => d.species === species),
          {
            x: "culmen_length_mm",
            y: "culmen_depth_mm",
            fill: "species",
            tip: true
          }
        ).plot({
          height: 320,
          color: {legend: true},
          x: {grid: true, label: "Bill length (mm)"},
          y: {grid: true, label: "Bill depth (mm)"}
        })
        """,
        key="penguins_plot",
    ),
)

mo.ui.anywidget(notebook.view())
```

`penguins`, `Inputs`, and `Plot` come from Notebook Kit. Changing the `viewof`
selection recomputes the plot in the browser.

## Cells, views, and inputs

`Notebook` accepts four kinds of cells:

| Helper          | Cell source                      |
| --------------- | -------------------------------- |
| `obs.js(...)`   | Standard Notebook Kit JavaScript |
| `obs.ojs(...)`  | Observable JavaScript            |
| `obs.md(...)`   | Markdown                         |
| `obs.html(...)` | HTML                             |

Top-level declarations in JavaScript cells form a reactive graph: when a value
changes, every cell that references it runs again.

_View_ means two things. In Python, `.view()` creates a renderable
`NotebookView` widget. In a JavaScript cell, `view(input)` displays a browser
input and defines its reactive value.

| Call                          | Result                                                            |
| ----------------------------- | ----------------------------------------------------------------- |
| `notebook.view()`             | A `NotebookView` that renders every cell.                         |
| `notebook.view(cells=[...])`  | A composite view of selected cells and their hidden dependencies. |
| `notebook.cell(0).view()`     | A focused view of one cell and its hidden dependencies.           |
| `view(input)` inside `obs.js` | A browser input whose value other cells can reference.            |

Create one view per place a notebook appears in the host. Views from the same
notebook stay connected: Python variable updates reach all of them, and named
`viewof` inputs share supported values across views.

## Python variables

Pass Python values to the browser through `variables`:

```python
import observablejs as obs

notebook = obs.Notebook(
    obs.js('html`<p>Threshold: <strong>${threshold}</strong></p>`'),
    variables={"threshold": 0.75},
)

full_view = notebook.view()
full_view
```

While the view stays mounted, call `notebook.update_variables(threshold=0.9)`
to update the value.

After the view renders, read browser values through `values` or `cell_values`
and inspect dependency metadata through `graph`.

## Load Notebook Kit HTML

Load a Notebook Kit HTML document:

```python
from pathlib import Path

import observablejs as obs

path = Path("chart.html")
notebook = obs.Notebook.from_html(
    path.read_text(encoding="utf-8"),
    base_path=path.parent,
    embed_file_attachments=True,
    rewrite_imports=True,
)
```

## Documentation

- [Quickstart](https://peter-gy.github.io/pyobservablejs/quickstart/)
- [Mental model](https://peter-gy.github.io/pyobservablejs/mental-model/)
- [Recipes](https://peter-gy.github.io/pyobservablejs/recipes/)
- [API reference](https://peter-gy.github.io/pyobservablejs/reference/)

## Acknowledgements

Thanks to the Observable team for [Notebook
Kit](https://github.com/observablehq/notebook-kit), which provides the notebook
APIs and runtime used throughout this project.
[`pyobsplot`](https://github.com/juba/pyobsplot) informed the Python variable
API, and [Trevor Manz](https://github.com/manzt)'s anywidget composition demo
shaped the widget design.

## License

MIT
