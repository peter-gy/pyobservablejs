# Author and operate notebook views

Use [SKILL.md](../SKILL.md) for the starter chart,
[hosts.md](hosts.md) for execution, [diagnose.md](diagnose.md) for failures, and
[data.md](data.md) for source and dataset access.

## Add a browser control

```python
import observablejs as obs

controls = obs.Notebook(
    obs.ojs(
        'viewof threshold = Inputs.range([0, 1], {value: 0.5, step: 0.1, label: "Threshold"})',
        key="control",
    ),
    obs.js(
        "const doubled = threshold * 2; display(html`<strong>${doubled}</strong>`);",
        key="summary",
    ),
)
control_view = controls.view("control")
summary_view = controls.view("summary")
```

Display both views with `display(control_view, summary_view)` in Jupyter or
`mo.hstack([control_view, summary_view])` in marimo. [Observable Inputs](https://observablehq.com/@observablehq/inputs)
provides the control and needs browser module access. The views share the
named `threshold` input. The focused summary view evaluates its hidden control
dependency. Its captured `doubled` starts at `1`.

`obs.js` uses `view(control)` for a reactive input. `obs.ojs` uses `viewof name`.
Use the cell language deliberately. A returned input DOM node alone does not
establish the intended reactive variable in a program cell.

## Patch values or restore authored computation

For the starter chart:

```python
notebook.update_variables({"minimum": 5})
```

Checkpoint the existing view using the host-appropriate workflow, then check
that `rowCount` changed from `2` to `1`. Patches update the live runtime.
DataFrames are serialized to rows. Keep large stable data in attachments when
frequent scalar updates would otherwise carry that data repeatedly.

Use `replace_variables(mapping)` for a complete Python-owned environment. It
rebuilds evaluation and releases omitted names to their authored definitions.
Use `reset_variables(*names)` to release specific names. For example:

```python
model = obs.Notebook(
    obs.ojs("minimum = 0", key="default_minimum"),
    variables={"minimum": 5},
)
model.reset_variables("minimum")
```

A subsequently displayed view evaluates authored `minimum` as `0`. Release a
name when an authored definition or another intended source can supply it.
Python patches clear the shared browser value for each patched name. Browser
interaction can then publish new input values. Treat `notebook.state` and
`view.state` as read-only snapshots and use controller methods for writes.

## Compose and style

Create another view to place the same output in another host location:

```python
second_chart = notebook.view("chart")
notebook.theme = {"light": "air", "dark": "ink"}
```

Each view owns its runtime, selected results, and diagnostics. Closing one view
leaves siblings active. Recheck each view whose output matters after changes.
Per-view nondeterministic or DOM state can differ even with shared inputs.

Use `show_pinned_source=True` when constructing a notebook if the source should
be visible. An authored cell can set `pinned=True` to opt into that source panel
and `display=False` to suppress implicit output while retaining evaluation.
Use `help(obs.Cell)` and `obs.NOTEBOOK_THEMES` for the installed options.

## Load a local attachment

Given `data/rows.csv` containing columns `category` and `value`:

```python
from pathlib import Path

files_notebook = obs.Notebook(
    obs.ojs('rows = FileAttachment("rows.csv").csv({typed: true})', key="rows"),
    obs.js(
        'display(Plot.barY(rows, {x: "category", y: "value"}).plot());', key="chart"
    ),
    files={"rows.csv": "rows.csv"},
    base_path=Path("data"),
)
files_view = files_notebook.view("chart")
```

Local bytes are captured at construction. Reconstruct the notebook to read a
changed file. `base_path` resolves relative paths, not an access restriction.
Use typed parsing when numbers/dates should be inferred, and explicit parsing
or transformations when lexical strings such as identifiers must be preserved.
URL-backed attachments are fetched by the browser and need network permission.

## Import Notebook Kit HTML

```python
from pathlib import Path

path = Path("notebooks/report.html")
imported = obs.Notebook.from_html(
    path.read_text(encoding="utf-8"),
    base_path=path.parent,
    embed_file_attachments=True,
    rewrite_imports=True,
)
imported_view = imported.view()
```

The options capture local literal file references and quoted relative JavaScript
modules using `base_path`. Remote dependencies can still require the network.
The imported source retains its theme and runtime profile. Treat imported HTML
and its dependencies as executable code with the host page's privileges.

## Reuse an ObservableHQ notebook or saved document

```python
imported = obs.Notebook.from_observablehq("@d3/bar-chart", timeout=10)
```

This fetches a public Observable document in Python. The displayed browser view
then resolves its runtime modules and attachments. Inspect `imported.cells`
before choosing a selection. Use canonical handles for anonymous cells.

For an already loaded document mapping:

```python
imported = obs.Notebook.from_observablehq_document(document)
```

Read JSON or compressed dataset storage with the data tooling appropriate to
that storage, then supply the document mapping. Preserve its `id` and `version`
to retain import provenance and dependency resolution. `source_document` holds
the original record, while `cells` describe the prepared Notebook Kit form.
Keep corpus samples and diagnostics in the user's designated artifact location.

## Export and finish

```python
source = notebook.to_notebook_html()
view.close()
notebook.close()
```

The HTML contains the definition. Retain Python inputs and attachment bytes
separately when the exported artifact must reproduce the live chart. Static
images require browser rendering and capture.

`view_from_code` and the other `view_from_*` factories create views that own a
temporary controller. Closing one closes that owned session. Prefer an explicit
`Notebook` when several views or later controller updates are part of the task.
Cancel unfinished browser requests before closing their view.
