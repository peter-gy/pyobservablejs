# Inspect source and extract data

Use `notebook.cells`, `notebook.files`, `notebook.data`, and `notebook.graph`.
Cell keys identify authored cells. Data names identify JavaScript variables.
Conversions return Python objects and dataframes directly.

```python
notebook.cells["chart"].source
notebook.files["sales.csv"].url
notebook.data.names()
notebook.graph.upstream("chart")
frame = notebook.data["sales"].to_polars(columns=["category", "value"], limit=1000)
```

Notebook data and graph inspection use the optional server extra. The default
engine is Deno. Network access is enabled by default; use
`notebook.data.using(network=False)` for offline execution. Use `notebook.data.using(engine="chromium")` for
actual browser capabilities. A notebook owns its lazy executions and closes
them through `close()` or its context manager.

## Widget route

A displayed view uses anywidget and needs no Deno:

```python
names = await view.data.names()
frame = await view.data["sales"].to_polars()
rows = await view.data["sales"].to_python(limit=10)
graph = await view.graph.snapshot()
```

Reads cover the view's evaluated cells and hidden dependencies. They work with
`capture_state=False`. In Jupyter, await reads after display. In marimo, schedule
an async task and let the executing cell finish, as described in [hosts.md](hosts.md).

For passive reactive observation, `view.inspection`, `view.datasets`, and
`view.diagnostics` publish readonly snapshots through traitlets. `view.state`
contains bounded previews, not full dataframe exports.

## Discovery and provenance

```python
catalog = await view.data.discover()
for dataset in catalog.datasets:
    print(dataset.name, await dataset.describe())
frame = await catalog.datasets["sales"].to_polars()
```

Discovery retains datasets when independent cells fail. Inspect `catalog.errors`
and `catalog.pending`. Discovered references pin value revisions and reject
stale reads. Direct `view.data[name]` references request the current value.

`describe()` reports kind, schema, row count, and native versus sampled schema
metadata. A sampled schema may not include every type or column in later rows.
`reference.sources` contains known static file and literal URL references, not
proof of actual fetches or exhaustive lineage. It is `None` before analysis is
available on an async reference.

## Conversions and files

Use `to_python()`, `to_polars()`, `to_pandas()`, or `to_arrow()`. Install the target
library. Evaluated pandas conversion also requires PyArrow. Polars consumes IPC
directly. Use `columns`, `offset`, `limit`, and `path` to bound reads. A conversion
returns one coherent detached value or raises, rather than silently truncating.

```python
raw = notebook.files["sales.csv"].read_bytes()
frame = notebook.files["sales.csv"].to_polars()
config = notebook.files["config.json"].to_python()
raw_from_browser = await view.files["sales.csv"].read_bytes()
```

Notebook file operations use Python I/O and need no Deno. View file operations use
the originating browser. Pass `format=` when filename, content type, and content
signatures cannot establish the parser. For advanced parsing, pass `read_bytes()`
to the dataframe library's own reader.

Headless data and Python files are synchronous by default. Their explicit async
accessors are `notebook.data.aio` and `notebook.files.aio`.
