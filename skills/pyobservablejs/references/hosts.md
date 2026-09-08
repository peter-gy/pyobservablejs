# Use the notebook's Python environment

Read [SKILL.md](../SKILL.md) for the object model and first chart.

## Install and discover

Use the notebook project's dependency manager or the host's package-management
API. Apply that project's version pins and lockfile policy. Install `pyarrow`
when Python must decode Arrow exports with `NotebookRead.to_arrow()`.

Check the running kernel, which may differ from a terminal environment:

```python
import sys
import observablejs as obs
import observablejs.agent as agent

print(sys.executable)
print(obs.__version__, obs.__file__)
print(agent.agent_plugin().tree())
skill = agent.agent_skill()
print(skill.file("references/diagnose.md").read_text(encoding="utf-8"))
```

If import or resource lookup fails, correct the installation in this environment
and repeat discovery. Restart a kernel that has already imported an older
version. Use installed `help()` and skill resources before assuming the website
matches a development checkout or an older environment.

A browser-backed host is required for evaluation. Plain Python can construct
and serialize notebooks and inspect their prepared cell handles. Browser
results, imports, plots, and requests require a mounted view. Remote modules and
attachments are subject to browser networking and the host's
[Content Security Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CSP),
which controls allowed resource origins and JavaScript execution.

## Jupyter

Display once, retaining the view:

```python
from IPython.display import display

display(view)
```

Run checkpoints and reads in a later cell:

```python
state = await view.ready(timeout=30)
count = await view.read("rowCount", format="json")
print(count.data)
```

Jupyter can process widget replies while this call awaits. `ready()` waits for
the Python update present at call time and returns validated state and
diagnostics, even when ordinary widget trait updates are delayed.

## Marimo code-mode discovery and editing

[marimo](https://marimo.io/) is a reactive notebook host. Its agent code-mode
API operates on the live notebook. Discover it in a dedicated scratchpad call:

```python
import marimo._code_mode as cm

help(cm)
```

This is an internal, agent-only marimo API with no stable version guarantee.
Read the installed help before using its methods. The current API exposes:

```python
import marimo._code_mode as cm

print(cm.capabilities())
ctx = cm.get_context()
[(cell.id, cell.name, cell.status) for cell in ctx.cells]
```

Scratchpad imports and new bindings are local to one call. Import `cm` again
in each call that uses it.

The `pyobservablejs` capability points to `observablejs.agent`. Read that
module's installed skill. A marimo cell is a Python host cell, distinct from an
Observable `NotebookCell` inside the widget.

Read the target host cell's `.code` before editing. Use the installed context's
`edit_cell` and `run_cell` methods inside `async with cm.get_context()` to persist
and execute the replacement. In the current host, editing alone does not run a
cell. Keep `cm` in the scratchpad rather than durable notebook code.

After a code-mode call that creates or reruns cells, start a new call and retrieve
live objects from `ctx.globals`:

```python
import marimo._code_mode as cm

ctx = cm.get_context()
active_view = ctx.globals["view"]
active_view.raise_for_errors()
```

Here `view` is the variable defined by the starter notebook. Use the actual
producer's variable name in an existing notebook. `ctx.globals` reflects reruns,
while a scratchpad's previous aliases and output snapshots may be stale.

Read host-level failures as well as widget diagnostics:

```python
import marimo._code_mode as cm

ctx = cm.get_context()
[
    {
        "cell": cell.id,
        "status": cell.status,
        "errors": [error.msg for error in cell.errors],
    }
    for cell in ctx.cells
    if cell.errors
]
```

For a runtime cell error, `error.exception` retains the Python exception. An
`obs.errors.ObservableError` there carries structured `.diagnostics`. Host graph
errors such as duplicate Python definitions must be fixed in the host cells.

## Browser requests in marimo

Current marimo processes widget replies on the same command loop as ordinary
cell and code-mode execution. Top-level async syntax does not make a direct
`await view.ready()` or `await view.read(...)` safe inside that executing call.
Start the request, return control, and consume its result later.

For reactive data reads, use two separate Python cells. The producer starts a
task and publishes success or failure through marimo's state API:

```python
import asyncio
import marimo as mo

get_data, set_data = mo.state(None)


async def load_rows():
    try:
        set_data(await view.read("visible", format="rows", limit=10))
    except Exception as error:
        set_data(error)


data_task = asyncio.create_task(load_rows())
```

The consumer runs after the producer has returned:

```python
data = get_data()
if isinstance(data, Exception):
    raise data
if data is not None:
    print(data.data)
```

The displayed `view` comes from the starter. A `None` value means the request
has not completed. Raising the stored exception gives the agent a failed Python
execution and full diagnostic text. Cancel an unfinished task before replacing
its view or launching a superseding request.

For code-mode checkpoints, retain tasks in a plain notebook-owned container and
launch them from the scratchpad. A task-producing cell that directly depends on
`view` can rerun when widget diagnostics arrive and replace its own checkpoint.
The container avoids that reactive dependency.

Inspect existing names before creating a helper, then create an unused name or
reuse the existing helper:

```python
import marimo._code_mode as cm

async with cm.get_context() as ctx:
    request_cell = ctx.create_cell("chart_checks = {}", name="chart_requests")
    ctx.run_cell(request_cell)
```

Start the request in a subsequent scratchpad call. Mutate this existing task
container rather than relying on scratchpad-local assignments to survive:

```python
import asyncio
import marimo._code_mode as cm

ctx = cm.get_context()
checks = ctx.globals["chart_checks"]
previous = checks.get("ready")
if previous is not None and not previous.done():
    previous.cancel()
checks["ready"] = asyncio.create_task(ctx.globals["view"].ready(timeout=30))
```

Return from that call. In a later call, retrieve the result, which raises any
stored exception:

```python
import marimo._code_mode as cm

ctx = cm.get_context()
task = ctx.globals["chart_checks"]["ready"]
if task.done():
    state = task.result()
    print(state.input_revision, state.pending)
else:
    print("Browser checkpoint pending")
```

Use the same container for one-off `view.read(...)` tasks. Cancel unfinished
tasks and remove consumed entries. Delete a temporary helper cell through
`ctx.delete_cell(...)` inside a context when finished, or retain it for repeated
checks. Do not spin in the same execution waiting for `task.done()`.

For continuous error feedback, a normal marimo cell can remain synchronous:

```python
_ = view.value
view.raise_for_errors()
```

This reruns on widget updates and raises received failures, including with
preview capture disabled. It does not certify that a newly requested evaluation
has completed. In marimo's editor, inspect the error cell and its traceback.
Served app mode can hide those development details.
