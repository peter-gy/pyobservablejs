# pyobservablejs

[![CI](https://github.com/peter-gy/pyobservablejs/actions/workflows/ci.yml/badge.svg)](https://github.com/peter-gy/pyobservablejs/actions/workflows/ci.yml)
[![PyPI](https://img.shields.io/pypi/v/pyobservablejs.svg)](https://pypi.org/project/pyobservablejs/)
[![Python versions](https://img.shields.io/pypi/pyversions/pyobservablejs.svg)](https://pypi.org/project/pyobservablejs/)
[![License](https://img.shields.io/pypi/l/pyobservablejs.svg)](https://github.com/peter-gy/pyobservablejs/blob/main/LICENSE)

Observable JavaScript notebooks as Python widgets.

`pyobservablejs` renders Observable JavaScript cells from Python and runs them with
Observable Notebook Kit in the browser. Python owns the notebook model, synced
OJS variables, and cell widgets. TypeScript owns Notebook Kit evaluation,
rendering, and runtime metadata.

```python
import observablejs as obs

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

`pyobservablejs` supports Python 3.11 or newer.

## Notebook Model

- `obs.Notebook(...)` builds a Notebook Kit notebook from Python-authored cells.
- `variables={...}` sets OJS variables. A matching notebook variable is overridden.
- `notebook.update_variables(...)` pushes Python-side changes into the live OJS
  runtime.
- `key="..."` gives Python a stable handle for a cell.
- `notebook.runtime_values` and `notebook.cell_by_key("key").values` read
  browser-synchronized outputs after rendering.
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
    obs.ojs('viewof gain = Inputs.range([0, 11], {value: 5})', key="gain"),
    obs.ojs("double = gain * 2", key="double"),
)

notebook
```

After the parent notebook has rendered in the browser, read the synced value
from a later Python cell:

```python
notebook.cell_by_key("gain").value("gain")
notebook.value("double")
```

## Source Notebooks

Load Notebook Kit HTML from a file:

```python
from pathlib import Path

path = Path("chart.html")
notebook = obs.Notebook.from_html_file(path)
```

For file-backed notebooks, set `embed_file_attachments=True` to embed local
`FileAttachment(...)` references. Set `rewrite_imports=True` to inline relative
JavaScript imports discovered in Notebook Kit script cells.

Load a public ObservableHQ notebook by URL, slug, or id:

```python
notebook = obs.Notebook.from_observablehq("https://observablehq.com/@mbostock/saving-svg")
```

Remote `FileAttachment(...)` entries are registered as URL-backed attachments,
so Plot notebooks and examples with uploaded files can render in the widget.
Pass `variables={...}` to override variables in a loaded notebook with Python values.

Use already-fetched ObservableHQ data with the constructor that matches the
input shape:

```python
document = json.loads(path.read_text())
notebook = obs.Notebook.from_observablehq_document(document)

page_data = json.loads(page_path.read_text())
notebook = obs.Notebook.from_observablehq_page_data(page_data)

notebook = obs.Notebook.from_observablehq_nodes(nodes, observable_files=files, title="Imported")
```

## Documentation

- [Getting started](docs/getting-started.md)
- [Examples](docs/examples/index.md)
- [Guides](docs/guides/index.md)
- [Reference](docs/reference/index.md)
- [Architecture](docs/internals/architecture.md)
- [Widget composition](docs/internals/widget-composition.md)
- [Development](docs/development.md)

## Built On

- [anywidget](https://anywidget.dev) and traitlets for widget composition and
  synced state
- [Observable Notebook Kit](https://github.com/observablehq/notebook-kit) and
  [@observablehq/runtime](https://github.com/observablehq/runtime) for cell
  transpilation and browser execution
- [Shiki](https://shiki.style/) for pinned source highlighting

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup, docs preview, and the
check commands used before sending changes for review.

## Acknowledgements

`pyobservablejs` builds on [Observable Notebook Kit](https://github.com/observablehq/notebook-kit)
and [@observablehq/runtime](https://github.com/observablehq/runtime).
[`pyobsplot`](https://github.com/juba/pyobsplot) informed the Python-to-OJS
variable API.

Thanks to [@manzt](https://github.com/manzt) (Trevor Manz) for the composable
anywidgets demo that helped shape the widget design.

## License

MIT
