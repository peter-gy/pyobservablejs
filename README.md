# observablejs

Observable JavaScript notebooks as Python widgets.

`observablejs` lets you write Observable JavaScript from Python, pass Python data
into the Observable runtime, and display the result anywhere
[anywidget](https://anywidget.dev) runs.

```python
import observablejs as ojs

rows = [
    {"letter": "A", "frequency": 0.0812},
    {"letter": "B", "frequency": 0.0149},
    {"letter": "C", "frequency": 0.0271},
    {"letter": "D", "frequency": 0.0432},
    {"letter": "E", "frequency": 0.1202},
]

ojs.Notebook(
    ojs.md("# Letter frequencies"),
    ojs.cell("""
    Plot.plot({
      height: 260,
      marginLeft: 48,
      y: {grid: true, label: "frequency"},
      marks: [
        Plot.ruleY([floor]),
        Plot.barY(rows, {x: "letter", y: "frequency", tip: true})
      ]
    })
    """),
    data={"rows": rows, "floor": 0.04},
)
```

## Install

```sh
pip install observablejs
```

or:

```sh
uv add observablejs
```

`observablejs` supports Python 3.10 through 3.14.

For dataframe and Arrow helpers:

```sh
uv add "observablejs[data]"
```

## Core Ideas

- `ojs.Notebook(...)` renders a Notebook Kit notebook from Python-authored cells.
- `data={...}` exposes Python values as normal Observable variables.
- `name="..."` gives a cell a stable Python handle through `notebook.cell(...)`.
- `Notebook.from_file(...)` and `Notebook.from_html(...)` load Notebook Kit HTML.
- `Notebook.from_url(...)` loads public Observable notebooks through Observable's
  document API.

```python
notebook = ojs.Notebook(
    ojs.md("# Inputs"),
    ojs.cell('viewof gain = Inputs.range([0, 11], {value: 5})', name="gain"),
    ojs.cell("gain * 2", name="double"),
)

notebook.cell("gain")
notebook.value("double")
```

## Public Observable Notebooks

Load a public Observable notebook by URL, slug, or id:

```python
notebook = ojs.Notebook.from_url("https://observablehq.com/@mbostock/saving-svg")
```

Remote `FileAttachment(...)` entries are registered as URL-backed attachments,
so Plot notebooks and examples with uploaded files can render in the widget.

## Notebook Kit HTML

Load an existing Notebook Kit HTML file:

```python
notebook = ojs.Notebook.from_file("chart.html")
```

Local `FileAttachment(...)` references and relative JavaScript imports are
embedded by default so the widget can move between notebook frontends.

## Documentation

- [Quickstart](docs/quickstart.md)
- [Concepts](docs/concepts.md)
- [Architecture](docs/architecture.md)
- [API reference](docs/api.md)
- [Development](docs/development.md)

## Built On

- [anywidget](https://anywidget.dev) for Python widget packaging
- traitlets for synced widget state
- [Observable Notebook Kit](https://github.com/observablehq/notebook-kit) and
  [@observablehq/runtime](https://github.com/observablehq/runtime) for
  compilation and runtime execution in the browser
- data URLs for portable local file attachments and imports

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup, workbench notebooks,
and the check commands used before sending changes for review.

## Acknowledgements

`observablejs` builds on [Observable Notebook Kit](https://github.com/observablehq/notebook-kit)
and [@observablehq/runtime](https://github.com/observablehq/runtime). It was also inspired by
[`pyobsplot`](https://github.com/juba/pyobsplot), which shows a clean path for
passing Python values into an Observable JavaScript context.

Thanks to [@manzt](https://github.com/manzt) (Trevor Manz) for the composable
anywidgets demo that helped shape the widget design.

## License

MIT
