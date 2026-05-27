# pyobservablejs

Observable JavaScript notebooks as Python widgets.

`pyobservablejs` renders Observable JavaScript cells from Python and runs them with
Observable Notebook Kit in the browser. Python owns the notebook model, synced
OJS variables, and cell widgets. TypeScript owns Notebook Kit evaluation,
rendering, and runtime metadata.

```python
import pyobservablejs as obs

rows = [
    {"letter": "A", "frequency": 0.0812},
    {"letter": "B", "frequency": 0.0149},
    {"letter": "C", "frequency": 0.0271},
    {"letter": "D", "frequency": 0.0432},
    {"letter": "E", "frequency": 0.1202},
]

obs.Notebook(
    obs.md("# Letter frequencies"),
    obs.ojs("""
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
    variables={"rows": rows, "floor": 0.04},
)
```

## Install

```sh
pip install pyobservablejs
```

or:

```sh
uv add pyobservablejs
```

`pyobservablejs` supports Python 3.10 through 3.14.

## Notebook Model

- `obs.Notebook(...)` builds a Notebook Kit notebook from Python-authored cells.
- `variables={...}` sets OJS variables. A matching notebook variable is overridden.
- `notebook.update_variables(...)` pushes Python-side changes into the live OJS
  runtime.
- `name="..."` gives Python a stable name for a cell.
- `notebook.values` and `notebook.cell("name").value` read browser-synchronized
  outputs after rendering.
- `notebook.graph` exposes Notebook Kit-derived cell definitions, references, and
  dependency edges.

Cell helpers keep the source mode explicit:

| Helper          | Source mode           |
| --------------- | --------------------- |
| `obs.ojs(...)`  | Observable JavaScript |
| `obs.js(...)`   | ES module JavaScript  |
| `obs.md(...)`   | Markdown              |
| `obs.html(...)` | HTML                  |

```python
notebook = obs.Notebook(
    obs.md("# Inputs"),
    obs.ojs('viewof gain = Inputs.range([0, 11], {value: 5})', name="gain"),
    obs.ojs("double = gain * 2", name="double"),
)

notebook.cell("gain")
```

After the notebook or cell widget has rendered in the browser, read the synced
value from a later Python cell:

```python
notebook.value("double")
```

## Source Notebooks

Load Notebook Kit HTML from a string:

```python
from pathlib import Path

path = Path("chart.html")
notebook = obs.Notebook.from_html(
    path.read_text(encoding="utf-8"),
    base_path=path.parent,
)
```

Local `FileAttachment(...)` references and relative JavaScript imports are
embedded by default so the widget can move between notebook frontends.

Load a public ObservableHQ notebook by URL, slug, or id:

```python
notebook = obs.Notebook.from_observablehq("https://observablehq.com/@mbostock/saving-svg")
```

Remote `FileAttachment(...)` entries are registered as URL-backed attachments,
so Plot notebooks and examples with uploaded files can render in the widget.
Pass `variables={...}` to override variables in a loaded notebook with Python values.

## Documentation

- [Quickstart](docs/quickstart.md)
- [Examples](docs/examples.md)
- [Concepts](docs/concepts.md)
- [Architecture](docs/architecture.md)
- [Widget composition](docs/composition.md)
- [API reference](docs/api.md)
- [Development](docs/development.md)

## Built On

- [anywidget](https://anywidget.dev) and traitlets for widget composition and
  synced state
- [Observable Notebook Kit](https://github.com/observablehq/notebook-kit) and
  [@observablehq/runtime](https://github.com/observablehq/runtime) for cell
  transpilation and browser execution
- [Shiki](https://shiki.style/) for pinned source highlighting

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup, workbench notebooks,
and the check commands used before sending changes for review.

## Acknowledgements

`pyobservablejs` builds on [Observable Notebook Kit](https://github.com/observablehq/notebook-kit)
and [@observablehq/runtime](https://github.com/observablehq/runtime).
[`pyobsplot`](https://github.com/juba/pyobsplot) informed the Python-to-OJS
variable API.

Thanks to [@manzt](https://github.com/manzt) (Trevor Manz) for the composable
anywidgets demo that helped shape the widget design.

## License

MIT
