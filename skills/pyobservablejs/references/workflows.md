# pyobservablejs workflows

Use these recipes after choosing the public `Notebook` and `NotebookView`
contract in `SKILL.md`.

## Load a local file

`files` maps the name used by `FileAttachment` to a local path, URL, or typed
record. `base_path` resolves local relative paths.

```python
from pathlib import Path

import observablejs as obs

data_dir = Path("data")
notebook = obs.Notebook(
    obs.ojs(
        'rows = FileAttachment("rows.csv").csv({typed: true})',
        key="rows",
    ),
    obs.js(
        'Plot.barY(rows, {x: "name", y: "value"}).plot()',
        key="chart",
    ),
    files={"rows.csv": "rows.csv"},
    base_path=data_dir,
)
```

Local bytes are captured when `Notebook` is constructed. Create another
notebook to capture later file contents.

## Import Notebook Kit HTML

```python
from pathlib import Path

import observablejs as obs

path = Path("notebooks/report.html")
notebook = obs.Notebook.from_html(
    path.read_text(encoding="utf-8"),
    base_path=path.parent,
    embed_file_attachments=True,
    rewrite_imports=True,
)
view = notebook.view()
```

`embed_file_attachments=True` captures local files referenced by literal
`FileAttachment(...)` calls. `rewrite_imports=True` embeds quoted relative
JavaScript modules. Both options resolve paths from `base_path`.

## Import an ObservableHQ notebook

```python
import observablejs as obs

notebook = obs.Notebook.from_observablehq("@d3/bar-chart", timeout=10)
view = notebook.view()
```

Use `Notebook.from_observablehq_document(document)` when a saved document API
mapping is already available. Preserve its `id` and `version` when imported
Observable dependencies must use the source revision.

## Compose synchronized views

```python
control_view = notebook.view("threshold_control")
summary_view = notebook.view("summary")
```

The views share controller variables and writable named browser inputs. Each
view has its own browser evaluation, selected cells, results, errors, graph,
and close lifecycle. A view belongs in one live output location. Create another
view when the same selection must render twice.

## Read results and errors

```python
state = view.state
if (
    not state.pending
    and state.input_revision is not None
    and state.settled_revision == state.input_revision
):
    result = state.result("chart")
    if result.status == "success":
        print(result.values)
    else:
        print(result.errors)

    if state.errors:
        print(state.errors)
```

`CellError` records evaluation failures for a selected cell. `ViewError`
records setup and view-level failures. Their `phase` values identify analysis,
evaluation, rendering, or serialization.

## Inspect dependencies

```python
graph = view.state.graph
if graph is not None:
    chart = graph.cell("chart")
    print(chart.defines, chart.references)
    print(graph.to_mermaid())
```

`NotebookGraph` is a detached read-only snapshot. Use cell keys for graph
lookup. `id` and `index` are serialization and notebook-order metadata.

## Export and close

```python
source = notebook.to_notebook_html()

view.close()
notebook.close()
```

`to_notebook_html()` exports the Notebook Kit definition. Controller variables
and local attachment bytes remain session state. A standalone
`view_from_code`, `view_from_html`, `view_from_observablehq`, or
`view_from_observablehq_document` result owns its temporary notebook, so
closing that view closes the owned session.
