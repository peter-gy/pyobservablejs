---
title: Notebook runtime
description: Runtime profiles, builtins, display, and invalidation for mounted views.
---

# Notebook runtime

Each mounted `NotebookView` evaluates its selected cells and their dependencies
in one Observable runtime. Cells share a reactive graph inside that view. A
top-level declaration defines a graph variable, and a cell that references the
variable runs again when its value changes.

The browser loads `Inputs` for this example. See [Builtins](#builtins) for
network and content security policy requirements.

```python
import observablejs as obs

notebook = obs.Notebook(
    obs.js(
        """
        const threshold = view(Inputs.range(
          [0, 1],
          {label: "Threshold", step: 0.05, value: 0.5}
        ));
        """
    ),
    obs.js('html`<p>Threshold: <strong>${threshold}</strong></p>`'),
)

full_view = notebook.view()
full_view
```

The input and readout update within `full_view`. A second call to
`notebook.view()` creates another runtime with its own output and readback. See
[Views and composition](views-and-composition.md) for selection, mounting, and
shared variables and input values.

## Runtime profiles

The notebook source selects the standard-library profile before a view starts.

| Source                                                       | Profile      |
| ------------------------------------------------------------ | ------------ |
| Python-authored cells                                        | Notebook Kit |
| Ordinary Notebook Kit HTML                                   | Notebook Kit |
| `Notebook.from_observablehq*`                                | Observable   |
| ObservableHQ-derived HTML serialized by `to_notebook_html()` | Observable   |

The Notebook Kit profile uses the builtins exported by Notebook Kit. The
Observable profile uses the classic Observable standard library. Both profiles
receive view-scoped `FileAttachment`, `document`, `width`, and `dark` values
from `pyobservablejs`.

ObservableHQ document imports stay pinned when the source document provides a
valid `id` and `version`. See [ObservableHQ notebooks](observablehq.md) for the
import and network contract.

## Display and inputs

JavaScript expression cells display their result. Program cells call
`display(...)` or `view(...)` when they need visible output.

| Form             | Runtime behavior                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `Plot.plot()`    | Displays the expression result. DOM nodes render directly, and other values use Notebook Kit's inspector.                 |
| `display(value)` | Adds a value to a program cell's output. A cell can call it more than once. The output clears before the cell runs again. |
| `view(input)`    | Displays an input and exposes its current value as a graph variable. Input events rerun dependent cells.                  |

`obs.js` accepts standard JavaScript. `obs.ojs` accepts Observable JavaScript
syntax such as `viewof` and `mutable` declarations. Both modes participate in
the same graph. See [Observable cells and reactivity](author-cells.md) for cell
syntax and helper options.

(builtins)=

## Builtins

The selected profile resolves builtins when cells reference them.

| Builtin      | Contract                                                                                                                                            |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Inputs`     | Creates controls, tables, and other input elements. Pass an input to `view(...)` to expose its changing value.                                      |
| `Plot`       | Creates Observable Plot marks. `Plot.plot()` and a mark's `.plot()` return DOM nodes.                                                               |
| `html`, `md` | Creates reactive HTML and Markdown DOM values from tagged templates.                                                                                |
| `Generators` | Provides `input`, `observe`, and `queue` in both profiles. Other methods come from the selected standard library.                                   |
| `Mutable`    | Creates a reactive source with a `.value` getter and setter. Consumers rerun after the value changes.                                               |
| `width`      | Yields the floored notebook root width with a 320-pixel minimum. It falls back to 928 when layout has no measurable width and updates after resize. |
| `dark`       | Yields whether the notebook root uses a dark color scheme. Theme changes rerun dependent cells.                                                     |

The Notebook Kit profile also exposes sample datasets such as `aapl`, `cars`,
and `penguins`. External libraries, sample datasets, module imports, and source
notebooks can require browser network access. The page content security policy
must permit every package, data, and module origin used by its cells.

Standard JavaScript cells can import an npm package or browser module.

```python
obs.js(
    """
    import {format} from "npm:d3-format@3";

    const compact = format(".2s");
    display(compact(42000));
    """
)
```

Use [Files and source notebooks](source-html.md) for `FileAttachment`, local
Notebook Kit HTML, and relative JavaScript modules.

## Promises, generators, and invalidation

Notebook Kit tracks asynchronous values as part of the graph.

| Value                        | Evaluation                                                             | Invalidation                                                                       |
| ---------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Promise                      | Dependent cells wait for the resolved value.                           | A stale resolution is ignored. The operation continues unless the cell cancels it. |
| Generator or async generator | The first yield defines the value. Later yields rerun dependent cells. | The runtime calls the generator's `return()` method.                               |
| `invalidation`               | Provides a promise for the current cell evaluation.                    | Resolves when the evaluation is invalidated or its runtime is disposed.            |

Use `invalidation` to release resources owned by a cell.

```python
obs.js(
    """
    const dataUrl = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json";
    const controller = new AbortController();
    invalidation.then(() => controller.abort());

    const response = await fetch(dataUrl, {signal: controller.signal});
    const records = await response.json();
    """
)
```

`NotebookView.close()` closes one runtime. `Notebook.close()` closes every view
created from that notebook.

## Python variables and readback

Python-owned variables enter the same graph and rerun their dependents when
they change. Runtime-owned builtin names cannot be Python variables. See
[Update from Python](python-variables.md) for the mounted-view workflow and
[Variables](../reference/variables.md) for serialization and reserved names.

Rendered values and graph metadata synchronize to the `NotebookView` that
produced them. Continue with [Values back to Python](cell-values.md) for the
readback lifecycle.
