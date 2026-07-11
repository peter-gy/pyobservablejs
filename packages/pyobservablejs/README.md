# pyobservablejs

[![CI](https://github.com/peter-gy/pyobservablejs/actions/workflows/ci.yml/badge.svg)](https://github.com/peter-gy/pyobservablejs/actions/workflows/ci.yml)
[![PyPI](https://img.shields.io/pypi/v/pyobservablejs.svg)](https://pypi.org/project/pyobservablejs/)
[![Python versions](https://img.shields.io/pypi/pyversions/pyobservablejs.svg)](https://pypi.org/project/pyobservablejs/)
[![License](https://img.shields.io/pypi/l/pyobservablejs.svg)](https://github.com/peter-gy/pyobservablejs/blob/main/LICENSE)

`pyobservablejs` renders Observable JavaScript notebooks in Jupyter and marimo.
`Notebook` stores the definition and shared session state. `NotebookView` runs
its selected cells through Observable Notebook Kit in the browser.

```sh
pip install pyobservablejs jupyterlab
```

Python 3.11 or newer is required.

The distribution is named `pyobservablejs`. Python code imports it as
`observablejs`.

Notebook Kit provides the `Plot` library and the `penguins` sample used below.
The browser loads both from jsDelivr, so it needs network access and a content
security policy that permits the CDN requests.

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

In marimo, wrap the view with `mo.ui.anywidget`.

```python
import marimo as mo

mo.ui.anywidget(full_view)
```

## Notebooks and views

`Notebook` accepts JavaScript, Observable JavaScript, Markdown, and HTML cells.

| Helper          | Cell source                      |
| --------------- | -------------------------------- |
| `obs.js(...)`   | Standard Notebook Kit JavaScript |
| `obs.ojs(...)`  | Classic Observable JavaScript    |
| `obs.md(...)`   | Markdown                         |
| `obs.html(...)` | HTML                             |

Top-level JavaScript declarations form a reactive graph across cells. Use
`view(...)` for browser-owned inputs.

Create `notebook.view()` for the complete notebook, call `view()` on a
`NotebookCell` selection, or pass `cells` for one composite runtime.

Python values cross into that graph through `variables`.

```python
notebook = obs.Notebook(
    obs.js('html`<p>Threshold: <strong>${threshold}</strong></p>`'),
    variables={"threshold": 0.75},
)

full_view = notebook.view()
notebook.update_variables(threshold=0.9)
```

After the browser renders the view, `full_view.runtime_values`,
`full_view.value(name)`, and `full_view.graph` expose synchronized values and
dependency metadata. Create a cell view with `notebook.cell_at(0).view()` or
render several selected cells through one runtime with
`notebook.view(cells=[0, 1])`.

## Existing notebooks

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

User guide:

- [Getting started](https://peter-gy.github.io/pyobservablejs/getting-started/)
- [Examples](https://peter-gy.github.io/pyobservablejs/examples/)
- [Learn](https://peter-gy.github.io/pyobservablejs/guides/)
- [Notebook runtime](https://peter-gy.github.io/pyobservablejs/guides/notebook-runtime/)
- [API reference](https://peter-gy.github.io/pyobservablejs/reference/)

Contributor documentation:

- [Development](https://github.com/peter-gy/pyobservablejs/blob/main/development_docs/development.md)
- [Architecture](https://github.com/peter-gy/pyobservablejs/blob/main/development_docs/architecture.md)
- [Workspace](https://github.com/peter-gy/pyobservablejs/blob/main/development_docs/workspace.md)
- [Documentation build](https://github.com/peter-gy/pyobservablejs/blob/main/development_docs/docs-build.md)

## Built on

- [anywidget](https://anywidget.dev) and traitlets for widget lifecycle, model
  resolution, and synchronized state
- [Observable Notebook Kit](https://github.com/observablehq/notebook-kit) and
  [@observablehq/runtime](https://github.com/observablehq/runtime) for cell
  transpilation and browser execution
- [Shiki](https://shiki.style/) for pinned source highlighting

## Contributing

See the [contributor guide](https://github.com/peter-gy/pyobservablejs/blob/main/CONTRIBUTING.md)
for local setup and the checks required before review.

## Acknowledgements

[`pyobsplot`](https://github.com/juba/pyobsplot) informed the Python-to-OJS
variable API. Thanks to [Trevor Manz](https://github.com/manzt) for the
composable anywidgets demo that helped shape the widget design.

## License

MIT
