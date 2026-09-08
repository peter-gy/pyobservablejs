---
name: pyobservablejs
description: >-
  Author, display, diagnose, and inspect Observable JavaScript notebooks from
  Python with pyobservablejs. Use for charts and controls in Jupyter or marimo,
  Python/browser synchronization, reusable notebook views, ObservableHQ imports,
  source and dataset analysis, Arrow exports, and structured widget errors.
---

# Build and diagnose with pyobservablejs

`pyobservablejs` runs [Observable Notebook Kit](https://observablehq.com/notebook-kit/)
cells in a browser through [anywidget](https://anywidget.dev/), a widget protocol
supported by Jupyter and marimo. Python constructs the notebook and supplies
values. Displaying a view starts browser evaluation.

## Use the target environment

Install the package with the target project's package manager and version policy.
Run discovery in the notebook kernel or its code-mode environment:

```python
import sys
import observablejs as obs
import observablejs.agent as agent

print(sys.executable, obs.__version__, obs.__file__)
skill = agent.agent_skill()
print(skill.body)
```

`agent.agent_plugin().tree()` lists the installed resources. Read a reference
with `skill.file("references/diagnose.md").read_text(encoding="utf-8")`.
The installed skill and `help(obs.NotebookView.ready)` match this environment.
[hosts.md](references/hosts.md) covers installation, Jupyter, and marimo code-mode.

## Keep the four objects distinct

| Object         | Use it for                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------ |
| `Notebook`     | Cell definitions, Python variables, attachments, theme, and shared session lifetime.                         |
| `NotebookCell` | A canonical cell handle. Use its key for authored selections and the handle for imported or anonymous cells. |
| `NotebookView` | One displayed selection with its own evaluation, results, diagnostics, and lifetime.                         |
| `DatasetInfo`  | An evaluated table's metadata and revision, owned by one view. Relist it after data or runtime changes.      |

Create one view per live output location. Views share controller variables and
serializable named browser inputs. A focused view evaluates its dependency
closure, hides dependency outputs, and captures the selected outputs. Source
and selection are fixed for that view. Edit the producer and construct a new
notebook/view when changing cell definitions.

## First chart

Use small cells with stable keys. Keep data transformations separate from drawing:

```python
import observablejs as obs

notebook = obs.Notebook(
    obs.js(
        "const visible = rows.filter(d => d.value >= minimum);",
        key="filtered",
    ),
    obs.js(
        """
        const rowCount = visible.length;
        display(Plot.barY(visible, {x: "category", y: "value"}).plot());
        """,
        key="chart",
    ),
    variables={
        "rows": [{"category": "A", "value": 3}, {"category": "B", "value": 7}],
        "minimum": 0,
    },
)
view = notebook.view("chart")
view
```

[Observable Plot](https://observablehq.com/plot/) draws the chart. Its builtin
loads in the browser and needs network access. Display `view` as a cell output
or in the host's layout. A terminal import or notebook construction does not
execute the JavaScript. Imported source runs with the host page's permissions.

Choose `obs.js` for standard JavaScript with top-level declarations,
`obs.ojs` for Observable syntax such as `viewof`, `obs.md` for Markdown, and
`obs.html` for HTML. Program cells use `display(...)` to render and `view(...)`
to connect controls to the reactive graph. See [workflows.md](references/workflows.md)
for controls, composition, files, and imports.

## Establish execution, then inspect the chart

In Jupyter, run this in a later cell after displaying the view:

```python
state = await view.ready(timeout=30)
print(state.result("chart").values["rowCount"])
```

The example prints `2`. After `notebook.update_variables({"minimum": 5})`, a
new `ready()` checkpoint returns the updated state with `rowCount == 1`.

In a marimo reactive cell, use:

```python
_ = view.value
view.raise_for_errors()
```

This raises received widget failures as Python cell errors. It is an immediate
check, not a wait for a new evaluation. For an awaited checkpoint in marimo,
including its code-mode scratchpad, use the task handoff in
[hosts.md](references/hosts.md#browser-requests-in-marimo).

**Empty diagnostics or an empty initial state do not establish successful
execution.** `ready()` requires `capture_state=True`, the default. With capture
disabled, diagnostics, source inspection, and explicit data reads still work,
but readiness and result previews are unavailable. Create a captured diagnostic
view when a complete evaluation checkpoint is required.

After a checkpoint, inspect the relevant data and the rendered chart. Confirm
expected marks, axes, labels, scales, and interactions. A clean evaluation can
still produce an empty or misleading chart. Follow
[diagnose.md](references/diagnose.md) for the structured procedure and repair loop.

## Choose the access path

| Task                                              | API or reference                                                       |
| ------------------------------------------------- | ---------------------------------------------------------------------- |
| Change Python inputs                              | `notebook.update_variables(patch)`                                     |
| Replace the Python-owned environment              | `notebook.replace_variables(mapping)`                                  |
| Restore authored computation                      | `notebook.reset_variables(*names)`                                     |
| Check or raise browser failures                   | `view.diagnostics`, `view.raise_for_errors()`, `await view.ready()`    |
| Read a selected cell's preview                    | `state.result("chart").values`                                         |
| Find source, dependencies, and imports            | `view.inspection`, `notebook.cells`                                    |
| List tables or read exact data                    | `view.datasets`, `await view.read(...)`, [data.md](references/data.md) |
| Configure hosts or live code-mode editing         | [hosts.md](references/hosts.md)                                        |
| Compose views, use files, import or export source | [workflows.md](references/workflows.md)                                |

Strings passed to `state.result()` and `notebook.view()` are cell keys.
Strings passed to `view.read()` are JavaScript variable names. Keep that
distinction explicit in code.

Let `obs.errors.ObservableError` subclasses propagate when the agent needs a
failed execution result. They include diagnostic context. Use `error.diagnostics`
or `view.diagnostics` for structured inspection. Keep summaries bounded and
retrieve specific data or source as needed.

Retain the controller and view while they are displayed. Close obsolete views
with `view.close()`. Close `notebook` when all its views are finished. Fetch
additional published docs through
[llms.txt](https://peter-gy.github.io/pyobservablejs/llms.txt) when the installed
resources do not cover the task.
