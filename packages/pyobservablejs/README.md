# pyobservablejs

[![CI](https://github.com/peter-gy/pyobservablejs/actions/workflows/ci.yml/badge.svg)](https://github.com/peter-gy/pyobservablejs/actions/workflows/ci.yml)
[![PyPI](https://img.shields.io/pypi/v/pyobservablejs.svg)](https://pypi.org/project/pyobservablejs/)
[![Python versions](https://img.shields.io/pypi/pyversions/pyobservablejs.svg)](https://pypi.org/project/pyobservablejs/)
[![License](https://img.shields.io/pypi/l/pyobservablejs.svg)](https://github.com/peter-gy/pyobservablejs/blob/main/LICENSE)

`pyobservablejs` renders Observable JavaScript notebooks in Jupyter and marimo.

For JupyterLab:

```sh
pip install pyobservablejs jupyterlab
```

Python 3.11 or newer is required.

Notebook Kit provides the `Plot` library and the `penguins` sample. The browser
loads both from jsDelivr, so it needs network access and a content security
policy that permits the CDN requests.

```python
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
full_view
```

For marimo, install the package with the notebook frontend and wrap the view
with `mo.ui.anywidget`.

```sh
pip install pyobservablejs marimo
```

```python
import marimo as mo

mo.ui.anywidget(full_view)
```

## Notebooks, views, and inputs

`Notebook` accepts JavaScript, Observable JavaScript, Markdown, and HTML cells.

| Helper          | Cell source                      |
| --------------- | -------------------------------- |
| `obs.js(...)`   | Standard Notebook Kit JavaScript |
| `obs.ojs(...)`  | Observable JavaScript            |
| `obs.md(...)`   | Markdown                         |
| `obs.html(...)` | HTML                             |

Top-level JavaScript declarations form a reactive graph across cells. The
Python methods create renderable notebook views. JavaScript `view(input)`
displays a browser input and defines its reactive value:

| Call                          | Result                                                               |
| ----------------------------- | -------------------------------------------------------------------- |
| `notebook.view()`             | Creates a `NotebookView` that selects every cell.                    |
| `notebook.view(cells=[...])`  | Creates a composite view for selected cells and hidden dependencies. |
| `notebook_cell.view()`        | Creates a focused view for one cell and its hidden dependencies.     |
| `view(input)` inside `obs.js` | Displays an input and defines its reactive value in the browser.     |

Create a separate Python view for each frontend display location. Views from
one notebook receive the same Python variable updates. Named Observable
JavaScript `viewof` inputs can share supported interacted values when their
controls use the same input type. The [variables
reference](https://peter-gy.github.io/pyobservablejs/reference/variables/#python-values-and-viewof-inputs)
lists the shared value shapes.

Pass Python values through `variables`.

```python
notebook = obs.Notebook(
    obs.js('html`<p>Threshold: <strong>${threshold}</strong></p>`'),
    variables={"threshold": 0.75},
)

full_view = notebook.view()
full_view
```

After the view renders, update a Python-owned value from Python.

```python
notebook.update_variables(threshold=0.9)
```

The rendered `full_view` exposes synchronized values and dependency metadata
through `runtime_values`, `value(name)`, and `graph`. Create a cell view with
`notebook.cell_at(0).view()` or use the views guide to render several selected
cells together.

See [Views and composition](https://peter-gy.github.io/pyobservablejs/guides/views-and-composition/)
for selection, mounting, shared variables and inputs, and readback.

## Existing notebooks

Load a trusted Notebook Kit HTML file:

```python
notebook = obs.Notebook.from_html_file(
    "chart.html",
    embed_file_attachments=True,
    rewrite_imports=True,
)
```

Load a trusted public ObservableHQ notebook:

```python
notebook = obs.Notebook.from_observablehq("@d3/bar-chart")
```

## Documentation

- [Getting started](https://peter-gy.github.io/pyobservablejs/getting-started/)
- [Examples](https://peter-gy.github.io/pyobservablejs/examples/)
- [Guides](https://peter-gy.github.io/pyobservablejs/guides/)
- [API reference](https://peter-gy.github.io/pyobservablejs/reference/)

## Contributing

See the [contributor guide](https://github.com/peter-gy/pyobservablejs/blob/main/CONTRIBUTING.md)
for local setup and the checks required before review.

## Acknowledgements

[`pyobsplot`](https://github.com/juba/pyobsplot) informed the Python variable
API. Thanks to [Trevor Manz](https://github.com/manzt) for the
composable anywidgets demo that helped shape the widget design.

## License

MIT
