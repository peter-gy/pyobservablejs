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

```sh
uvx --with pyobservablejs marimo edit notebook.py
```

### Load an existing Observable notebook

[![Open in molab](https://molab.marimo.io/molab-shield.svg)](https://molab.marimo.io/github/peter-gy/pyobservablejs/blob/main/examples/from-observablehq.py/wasm?utm_source=pyobservablejs)

```python
import observablejs as obs

notebook = obs.Notebook.from_observablehq("@d3/world-tour")
notebook.view()
```

`@d3/world-tour` resolves to
[observablehq.com/@d3/world-tour](https://observablehq.com/@d3/world-tour).

![from-observablehq-output](https://files.peter.gy/projects/pyobservablejs/assets/from-slug.gif)

### Author a notebook from code

[![Open in molab](https://molab.marimo.io/molab-shield.svg)](https://molab.marimo.io/github/peter-gy/pyobservablejs/blob/main/examples/from-code.py/wasm?utm_source=pyobservablejs)

```python
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
    ),
)

notebook.view()
```

`penguins`, `Inputs`, and `Plot` come from Notebook Kit. The Observable
JavaScript [`viewof` operator](https://observablehq.com/@observablehq/views)
updates `species` when the selection changes, which recomputes the plot in the
browser.

![from-code-output](https://files.peter.gy/projects/pyobservablejs/assets/from-code.gif)

### Sync values with Python

[![Open in molab](https://molab.marimo.io/molab-shield.svg)](https://molab.marimo.io/github/peter-gy/pyobservablejs/blob/main/examples/sync-variables.py/wasm?utm_source=pyobservablejs)

Pass Python values to the browser through `variables`:

```python
import observablejs as obs

notebook = obs.Notebook(
    obs.ojs(
        """
        viewof threshold = Inputs.range([0, 1], {
          value: 0.75,
          step: 0.05,
          label: "Threshold"
        })
        """
    ),
    obs.js('html`<p>Threshold: <strong>${threshold}</strong></p>`'),
    variables={"threshold": 0.75},
)

notebook_view = notebook.view()
notebook_view
```

![sync-variables-output](https://files.peter.gy/projects/pyobservablejs/assets/sync-variables.gif)

While the view stays mounted, call `notebook.update_variables(threshold=0.9)`
to update the value. The update takes place through
[Observable's runtime](https://github.com/observablehq/runtime), meaning
that the Python notebook object does not need to be recreated.

After the view renders, `notebook_view.values["threshold"]` reads the current
browser value.

## Documentation

Read the [documentation](https://peter-gy.github.io/pyobservablejs/) to learn more about
notebook sources, cells and views, Python and browser dataflow, runtime values, graph
inspection, recipes, and the API reference.

## Acknowledgements

Thanks to the Observable team for [Notebook
Kit](https://github.com/observablehq/notebook-kit), which provides the notebook
APIs and runtime used throughout this project.
[`pyobsplot`](https://github.com/juba/pyobsplot) informed the Python variable
API, and [Trevor Manz](https://github.com/manzt)'s anywidget composition demo
shaped the widget design.

## License

MIT
