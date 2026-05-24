# observablejs

Observable notebooks as Python widgets.

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

## API

Create notebooks from cells:

```python
ojs.Notebook(
    ojs.md("# Inputs"),
    ojs.cell('viewof gain = Inputs.range([0, 11], {value: 5})', name="gain"),
    ojs.cell("gain * 2", name="double"),
)
```

Use `ojs.cell(...)` for Observable JavaScript. Use `ojs.module(...)` only when
you need a Notebook Kit ES module cell.

```python
ojs.Notebook(
    ojs.module(
        "const answer = 42;",
        attrs={"output": "answer"},
    ),
    ojs.cell("answer"),
)
```

Helpers:

| Helper | Notebook Kit mode |
| --- | --- |
| `ojs.cell(...)` | Observable JavaScript |
| `ojs.module(...)` | ES module JavaScript |
| `ojs.md(...)` | Markdown |
| `ojs.html(...)` | HTML |
| `ojs.sql(...)` | SQL |

Multiline helper strings are dedented by default, so indented Python code can
contain readable Observable code. Pass `raw=True` only when whitespace must be
preserved exactly.

## Python Data

Pass Python values with `data`. They become normal Observable variables.

```python
import datetime as dt
import observablejs as ojs

events = [
    {"date": dt.date(2026, 5, 23), "value": 12},
    {"date": dt.date(2026, 5, 24), "value": 18},
]

notebook = ojs.Notebook(
    ojs.cell("""
    Plot.plot({
      x: {type: "utc"},
      marks: [Plot.lineY(events, {x: "date", y: "value", marker: true})]
    })
    """),
    data={"events": events},
)
```

Update data from Python:

```python
notebook.data = {"events": events[-1:]}
```

`data` accepts JavaScript identifier names mapped to serializable Python values:

- `None`, booleans, strings, integers, finite floats, `NaN`, and infinities
- lists, tuples, ranges, iterables, and nested dictionaries
- `datetime.date` and `datetime.datetime`, revived as JavaScript `Date` values
- bytes-like values, revived as `Uint8Array`
- NumPy scalar and array values via `item()` or `tolist()`
- pandas and Polars series as lists
- pandas and Polars dataframes as records

Dataframe serialization is deterministic: dataframes become records by default.
Use `ojs.arrow(df)` when you explicitly want an Arrow table, or `ojs.records(df)`
when you want to make the record conversion explicit.

```python
ojs.Notebook(
    ojs.cell("Inputs.table(rows)"),
    data={"rows": ojs.records(df)},
)
```

## File Attachments

Use `attachments` for manual `FileAttachment(...)` inputs:

```python
ojs.Notebook(
    ojs.cell('FileAttachment("points.csv").csv()'),
    attachments={"points.csv": "data/points.csv"},
)
```

When loading a Notebook Kit HTML file, local `FileAttachment(...)` references are
embedded automatically. Relative static and dynamic JavaScript imports are also
rewritten as data URLs when `portable=True`.

```python
notebook = ojs.Notebook.from_file("chart.html")
```

Use `portable=False` to leave source references untouched.

```python
notebook = ojs.Notebook.from_file("chart.html", portable=False)
```

Inline HTML works the same way:

```python
notebook = ojs.Notebook.from_html("""
<!doctype html>
<notebook>
  <script id="1" type="application/vnd.observable.javascript">
    viewof name = Inputs.text({label: "Name", value: "Observable"})
  </script>
  <script id="2" type="application/vnd.observable.javascript">
    md`Hello, **${name}**.`
  </script>
</notebook>
""")
```

## Cell Handles

Name cells when you want to display or inspect them individually:

```python
notebook = ojs.Notebook(
    ojs.cell('viewof gain = Inputs.range([0, 11])', name="gain"),
    ojs.cell("gain * 2", name="readout"),
)

notebook.cell("gain")
notebook.cell("gain").value
notebook.value("gain")
```

In marimo:

```python
import marimo as mo
import observablejs as ojs

notebook = ojs.Notebook(
    ojs.cell('viewof gain = Inputs.range([0, 11])', name="gain"),
    ojs.cell("gain * 2", name="readout"),
)

mo.ui.anywidget(notebook.cell("gain"))
```

## Notebook Graph

After the browser renders a notebook, `notebook.graph` exposes Notebook
Kit-derived symbolic metadata for the cells:

```python
graph = notebook.graph
assert graph is not None
graph.cells[0].defines
graph.cells[0].references
graph.edges

notebook.cell("gain").info
notebook.cell("gain").defines
notebook.cell("gain").references
notebook.defining_cell("gain")
```

The graph is produced in TypeScript from Notebook Kit `transpile(...)` metadata.
It reports Python-visible variable names in `defines`, referenced variables in
`references`, and raw runtime output names in `runtime_outputs`.

## Export

`to_notebook_html()` returns Notebook Kit HTML for Python-authored notebooks, or
the original source for source-backed notebooks.

```python
html = notebook.to_notebook_html()
```

## How It Works

`observablejs` uses:

- [anywidget](https://anywidget.dev) for Python widget packaging
- traitlets for synced widget state
- [Observable Notebook Kit](https://github.com/observablehq/notebook-kit) for
  compilation and runtime execution in the browser
- data URLs for portable local file attachments and imports

Python cells are serialized to Notebook Kit HTML, Python data is converted to
wire-safe values, and anywidget displays the resulting Observable runtime.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup, workbench notebooks,
and the check commands used before sending changes for review.

## Acknowledgements

`observablejs` builds on [Observable Notebook Kit](https://github.com/observablehq/notebook-kit)
and the Notebook Kit browser runtime. It was also inspired by
`/Users/petergy/Projects/opensource/juba/pyobsplot`, which clarified how Python
values can be passed cleanly into an Observable JavaScript context.

Thanks also to [@manzt](https://github.com/manzt) (Trevor Manz), whose demo of
composable anywidgets got my brain started in the right direction.

## License

MIT
