# Diagnose a chart

Start from the displayed view that contains the chart. Its controller is
`view.notebook`. Read
[hosts.md](hosts.md) for the host-specific way to run checkpoints and requests.
A successful Python constructor, empty diagnostics, or a DOM preview string is
insufficient evidence that the chart is correct.

## 1. Establish what actually ran

For Jupyter, after display:

```python
state = await view.ready(timeout=30)
{
    "input_revision": state.input_revision,
    "settled_revision": state.settled_revision,
    "pending": state.pending,
    "results": [
        {
            "key": result.cell.key,
            "index": result.cell.index,
            "status": result.status,
            "variables": list(result.values),
        }
        for result in state.results
    ],
}
```

For marimo, collect this checkpoint through the background-task handoff in
[hosts.md](hosts.md#browser-requests-in-marimo). Let a failed checkpoint raise.
The successful result certifies the current evaluated selection, including
its dependency failures. It does not execute unrelated, unselected cells.

| Observation                                    | Interpretation and next action                                                                                                                             |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `input_revision is None`                       | No captured browser evaluation has arrived. Confirm display, correct view, and browser connection.                                                         |
| `pending` or unequal revisions                 | Work is still evaluating. Inspect current diagnostics, imports, and requests before increasing a timeout.                                                  |
| `view.diagnostics == ()`                       | No current reported failures. This alone does not prove mounting or completion.                                                                            |
| `capture_state=False`                          | Preview state remains initial and `ready()` is unavailable. Use diagnostics and explicit reads, or display a separate captured view for a full checkpoint. |
| A completed checkpoint with successful results | Evaluation passed for this view. Check the data and visual output next.                                                                                    |

For a capture-disabled view, create `notebook.view(*view.cells)` as a separate
captured diagnostic view. Display it in another location, then checkpoint it.
This evaluates a new runtime with shared inputs. It cannot certify private DOM
state or view-local nondeterministic values in the original view, which still
needs direct browser inspection.

A `ready()` call is a checkpoint, not a permanent certificate. Recheck after
changing Python values or browser inputs. Use `raise_for_errors()` in reactive
marimo cells to expose failures from later generator updates.

## 2. Retrieve structured failures

For current view diagnostics:

```python
from dataclasses import asdict

records = [asdict(diagnostic) for diagnostic in view.diagnostics]
records
```

These dictionaries contain `name`, `message`, `origin`, `phase`, `component`,
`operation`, `stack`, `cause`, `variable`, and `cell`. Cell records contain
`key`, `index`, `id`, `mode`, and a source excerpt. `cause` recursively describes
the underlying error. Captured browser stacks are included when available.

A read can fail without making the entire view fail. Preserve diagnostics from
that operation's exception:

```python
try:
    result = await view.read("visible", format="rows", limit=10)
except obs.errors.ObservableError as error:
    operation_diagnostics = [asdict(diagnostic) for diagnostic in error.diagnostics]
    raise
```

The exception text is already formatted for agent execution output. Inspect
selected structured fields in a subsequent call instead of repeatedly dumping
full stacks and notebook source.

| Exception              | Repair direction                                                                                                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NotebookError`        | Inspect the producing cell, referenced variables, imports, and input data. Fix authored source or inputs.                                                                               |
| `WidgetError`          | Inspect the named component, operation, stack, and cause against the installed package source. The component is a handling boundary, not proof that the defect is in that file.         |
| `SerializationError`   | Distinguish a preview conversion failure from an evaluation failure. Read tables as Arrow/rows and supported scalar structures as JSON. Inspect DOM nodes and functions in the browser. |
| `ReadError`            | Check the variable selector, data format, projection, path, attachment, and dataset revision.                                                                                           |
| `ProtocolError`        | Preserve the traceback and installed package versions. Investigate incompatible browser assets or malformed messages rather than changing chart encodings.                              |
| `StaleViewError`       | Obtain the current view and fresh dataset descriptors, then repeat the intended operation if it still applies.                                                                          |
| `ViewClosedError`      | Use a live view. Create and display another when the session is still open.                                                                                                             |
| `NotebookTimeoutError` | Confirm browser mounting and command-loop progress, then inspect unresolved imports or long-running work. A longer timeout will not repair a blocked host loop.                         |

Local `TypeError` and `ValueError` usually identify invalid Python arguments.
Do not turn a caught exception into a successful agent response that says the
chart passed. Either let it propagate or retain the error and explicitly report
the failed check.

## 3. Locate the producer and dependencies

For the starter's `chart` key:

```python
print(notebook.cell("chart").source)
inspection = view.inspection
if inspection is not None:
    chart = inspection.graph.cell("chart")
    print(chart.defines, chart.references)
    inputs = [
        {"from": edge.source.key or edge.source.index, "variable": edge.variable}
        for edge in inspection.graph.edges
        if edge.target.index == chart.index
    ]
    print(inputs)
```

`view.inspection` covers the full prepared definition. `view.state.graph` covers
the evaluated selection and dependency closure. A static analysis error in an
unselected cell is a separate finding from the displayed chart's execution.
`graph.external_references` also contains runtime builtins and Python inputs,
so its entries are not automatically missing variables.

For imported cells, inspect `[(cell.key, cell.index, cell.mode) for cell in
notebook.cells]` and use the actual canonical handle. Avoid inventing keys from
a notebook's serialized id or JavaScript variable name. Prepared cells can
include helpers, so their indexes need not match original document node indexes.

Inspect relevant `inspection.imports` and `inspection.attachments` when the
failure concerns loading. Their records identify the referencing cells,
resolved import targets, file names, URLs, and metadata. A computed dynamic
import can have `source=None` and `resolved=None`.

## 4. Check data before changing chart options

For the starter, `visible` is the transformed table consumed by the chart:

```python
sample = await view.read("visible", format="rows", limit=10)
count = await view.read("rowCount", format="json")
print(sample.data, count.data)
```

Expect two rows and count `2` at `minimum=0`, then one row and count `1` at
`minimum=5`. Replace these with domain expectations for the actual chart.
Check the input table and intermediate transformations, not just the final
plot object. Use a targeted projection and limit before requesting full data.

Check field names and actual types, null/non-finite values, date interpretation,
filters, grouping, aggregation, joins, sort order, units, and expected row counts.
An empty array or a wrong field name can produce a blank chart without an
exception. Native or sampled schema metadata is a starting point. Sampling
cannot establish every row's type or validity. See [data.md](data.md).

## 5. Inspect the rendered chart

Use the connected browser or the host's installed screenshot API after allowing
the mounting/editing call to return. A screenshot is evidence of the rendered
output, while `.state` provides computational evidence.

Verify the expected chart and controls are visible. Check axes and units,
scale domains and transformations, category order, legends, color meaning,
clipping, overlaps, container width, and legibility at the target size. Exercise
the controls affected by the change, then verify both the image and updated data
or named values. Check browser console/network failures relevant to the target.
Keep other notebook views and unrelated page errors distinct.

After a fix, repeat the original failing action and the same checkpoint/data
checks. Report the view/selection tested, checkpoint outcome, data assertions,
visual observations, and any incomplete checks. State success for that scope.

Return or await notebook asynchronous work so Observable Runtime can observe
rejections. Detached timers/promises, upstream asynchronous generator disposal,
and failures after the comm closes can remain outside widget diagnostics.
