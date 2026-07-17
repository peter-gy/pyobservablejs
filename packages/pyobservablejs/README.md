# pyobservablejs

[![CI](https://github.com/peter-gy/pyobservablejs/actions/workflows/ci.yml/badge.svg)](https://github.com/peter-gy/pyobservablejs/actions/workflows/ci.yml)
[![PyPI](https://img.shields.io/pypi/v/pyobservablejs.svg)](https://pypi.org/project/pyobservablejs/)
[![Python versions](https://img.shields.io/pypi/pyversions/pyobservablejs.svg)](https://pypi.org/project/pyobservablejs/)
[![License](https://img.shields.io/pypi/l/pyobservablejs.svg)](https://github.com/peter-gy/pyobservablejs/blob/main/LICENSE)

`pyobservablejs` renders Observable JavaScript notebooks from Python. Author
cells in Python and pass values in both directions: Python variables drive the
reactive graph in the browser, and rendered values synchronize back to Python.

Each view is an [anywidget](https://anywidget.dev/), so notebooks render in
any anywidget host: JupyterLab, marimo, VS Code notebooks, Google Colab, and
others.

## Install

Python 3.11 or newer is required.

```sh
uv add pyobservablejs
```

## Quick start

This example uses marimo as the host:

```sh
uv add marimo
uv run marimo edit notebook.py
```

```python
import marimo as mo
import observablejs as obs

notebook = obs.Notebook(
    obs.js(
        """
        Plot.dot(penguins, {
          x: "culmen_length_mm",
          y: "culmen_depth_mm",
          fill: "species",
          tip: true
        }).plot({
          height: 320,
          color: {legend: true},
          x: {grid: true, label: "Bill length (mm)"},
          y: {grid: true, label: "Bill depth (mm)"}
        })
        """
    )
)

full_view = notebook.view()
mo.ui.anywidget(full_view)
```

`Plot` and the `penguins` sample ship with Notebook Kit and load from jsDelivr
at render time.

In Jupyter and most other hosts, display the view directly by leaving it as
the final expression in a cell:

```sh
uv add jupyterlab
uv run jupyter lab
```

```python
full_view
```

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
| `notebook.cell_at(0).view()`  | A focused view of one cell and its hidden dependencies.           |
| `view(input)` inside `obs.js` | A browser input whose value other cells can reference.            |

Create one view per place a notebook appears in the host. Views from the same
notebook stay connected: Python variable updates reach all of them, and named
`viewof` inputs share their values across views.

## Python variables

Pass Python values to the browser through `variables`:

```python
notebook = obs.Notebook(
    obs.js('html`<p>Threshold: <strong>${threshold}</strong></p>`'),
    variables={"threshold": 0.75},
)

full_view = notebook.view()
full_view
```

Update a value while the view stays mounted:

```python
notebook.update_variables(threshold=0.9)
```

After the view renders, read browser values and dependency metadata back
through `runtime_values`, `value(name)`, and `graph`.

## Load existing notebooks

Load a Notebook Kit HTML file:

```python
notebook = obs.Notebook.from_html_file(
    "chart.html",
    embed_file_attachments=True,
    rewrite_imports=True,
)
```

Load a public ObservableHQ notebook:

```python
notebook = obs.Notebook.from_observablehq("@d3/bar-chart")
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
