---
title: Notebook runtime
description: Use Notebook Kit display, inputs, files, builtins, imports, and reactive lifecycle.
---

# Notebook runtime

`Notebook` evaluates its cells in one Observable Notebook Kit runtime. A
top-level JavaScript declaration becomes a graph variable. Cells that reference
that variable run again when its value changes.

This live notebook uses the runtime-owned `Inputs`, `Plot`, and `penguins`
builtins. Change the species to update the chart.

```{marimo-config}
:pyproject:

  requires-python = ">=3.11"
  dependencies = [
      "pyobservablejs",
  ]
```

```{marimo} python
:echo: true

import marimo as mo
import observablejs as obs

notebook = obs.Notebook(
    obs.js(
        """
        const species = view(Inputs.select(
          ["All", ...new Set(penguins.map((d) => d.species))],
          {label: "Species", value: "All"}
        ));
        """
    ),
    obs.js(
        """
        Plot.dot(
          species === "All"
            ? penguins
            : penguins.filter((d) => d.species === species),
          {
            x: "culmen_length_mm",
            y: "culmen_depth_mm",
            fill: "species",
            tip: true
          }
        ).plot({
          height: 300,
          color: {legend: true},
          x: {grid: true, label: "Bill length (mm)"},
          y: {grid: true, label: "Bill depth (mm)"}
        })
        """
    ),
)

mo.ui.anywidget(notebook)
```

The first cell defines `species` through a browser input. The Plot cell
references `species`, so Notebook Kit schedules it again after each selection.

## Display values

JavaScript cells display expressions automatically. Program cells use
`display(...)` or `view(...)` when they need visible output.

| Form             | Runtime behavior                                                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `Plot.plot()`    | Displays the expression result. DOM nodes are inserted into the cell output. Other values use Notebook Kit's inspector.                 |
| `display(value)` | Adds `value` to a program cell's output. A cell may call `display` more than once. Previous output is cleared when the cell runs again. |
| `view(input)`    | Displays an input element and exposes its current value as a reactive variable. Input events rerun dependent cells.                     |

`Inputs` creates controls and tabular displays. Pass an input to `view` when
other cells should react to it.

```python
obs.js(
    """
    const threshold = view(Inputs.range(
      [0, 1],
      {label: "Threshold", step: 0.05, value: 0.5}
    ));
    """
)
```

## Cells and template builtins

Python cell helpers choose the Notebook Kit source mode. Runtime template tags
produce dynamic content inside JavaScript cells.

| Need                     | Use                                   | Contract                                                                        |
| ------------------------ | ------------------------------------- | ------------------------------------------------------------------------------- |
| Markdown cell            | `obs.md("## Summary")`                | Renders CommonMark and resolves `${...}` references through the notebook graph. |
| HTML cell                | `obs.html("<strong>Ready</strong>")`  | Renders HTML and escapes interpolated values.                                   |
| Markdown from JavaScript | `` md`Total: **${total}**` ``         | Returns rendered Markdown as a DOM value.                                       |
| HTML from JavaScript     | `` html`<strong>${label}</strong>` `` | Returns a DOM value and escapes interpolated text.                              |

Use `obs.js` for standard JavaScript and `obs.ojs` for classic Observable
JavaScript syntax such as `viewof` and `mutable` declarations. Both modes share
the same graph.

## Runtime builtins

Notebook Kit resolves builtins lazily when a cell references them.
External-library builtins such as `Inputs` and `Plot`, plus sample datasets,
load from jsDelivr. The browser needs network access and a content security
policy that permits those CDN requests.

| Builtin      | Contract                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `Inputs`     | Creates controls, tables, and other input elements. Use `view(...)` to expose an input's changing value.                 |
| `Plot`       | Creates Observable Plot marks and plots. Plot expressions return DOM nodes that cells can display directly.              |
| `html`, `md` | Create reactive HTML and Markdown DOM values from tagged templates.                                                      |
| `Generators` | Creates async reactive sources from callbacks, queues, DOM inputs, time, color scheme, and element width.                |
| `Mutable`    | Creates a reactive source with a `.value` getter and setter. Consumers rerun after `.value` changes.                     |
| `width`      | Yields the notebook root width in CSS pixels. The value is rounded down, has a minimum of 320, and updates after resize. |
| `dark`       | Yields a boolean from the notebook root's color scheme and the browser preference. Theme changes rerun dependent cells.  |

Classic OJS cells can use `mutable count = 0`. Standard JavaScript cells can
create the same source with `Mutable(0)` and update its `.value` from a callback
defined in that cell.

`Generators.observe` keeps the latest pushed value. `Generators.queue` yields
every pushed value in order. `Generators.input` converts input events into
values. An `observe` or `queue` initializer may return a cleanup function, which
runs when the source is invalidated.

## File attachments

Register files with `Notebook(files=...)`, then read them by name with
`FileAttachment`. Local paths are resolved against `base_path` when it is set.
URLs remain URL-backed attachments.

```python
from pathlib import Path

notebook = obs.Notebook(
    obs.js(
        'const rows = FileAttachment("rows.csv").csv({typed: true});'
    ),
    obs.js("Inputs.table(rows)"),
    files={"rows.csv": Path("data/rows.csv")},
)
```

A promise returned by `FileAttachment(...).csv()` becomes the resolved `rows`
value for dependent cells.

| Method group        | Methods                                                                  |
| ------------------- | ------------------------------------------------------------------------ |
| Raw response data   | `.url()`, `.blob()`, `.arrayBuffer()`, `.stream()`, `.text()`            |
| Structured data     | `.json()`, `.csv()`, `.tsv()`, `.dsv()`                                  |
| Documents and media | `.image()`, `.xml()`, `.html()`                                          |
| Data formats        | `.arrow()`, `.arquero()`, `.parquet()`, `.zip()`, `.xlsx()`, `.sqlite()` |

`FileAttachment(...).sqlite()` requires a page-provided sql.js `initSqlJs`
loader. It returns a `SQLiteDatabaseClient` with `query`, `queryRow`, `sql`, and
schema inspection methods.

Use [files and source notebooks](source-html.md) to discover local attachments
from Notebook Kit HTML or embed relative JavaScript imports.

## Built-in datasets

Notebook Kit provides sample datasets as graph variables. They load lazily in
the browser, so the viewer needs network access to the dataset host.

| Values                                                                                                                  | Shape                         |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `aapl`, `alphabet`, `cars`, `citywages`, `diamonds`, `flare`, `industries`, `olympians`, `penguins`, `pizza`, `weather` | Arrays of auto-typed CSV rows |
| `miserables`                                                                                                            | A JSON graph object           |

Referencing cells receive the loaded value. The first live example uses
`penguins` directly, with no Python variable or import.

## Standard module imports

`obs.js` accepts static and dynamic JavaScript imports. Use the `npm:` protocol
for npm packages or a browser-importable URL.

```python
obs.js(
    """
    import {format} from "npm:d3-format@3";

    const compact = format(".2s");
    display(compact(42000));
    """
)
```

Modules load in the browser. The viewer must be able to reach the package or
URL origin. For relative modules in file-backed Notebook Kit HTML, use
`Notebook.from_html_file(..., rewrite_imports=True)` to embed the import graph.

## Promises, generators, and invalidation

Notebook Kit tracks asynchronous values as part of the reactive graph.

| Value                        | On evaluation                                                                        | On invalidation                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Promise                      | Dependent cells wait for the resolved value.                                         | A stale resolution is ignored. The underlying operation keeps running unless the cell cancels it. |
| Generator or async generator | The first yield becomes the variable value. Each later yield reruns dependent cells. | The runtime calls the generator's `return()` method.                                              |
| `invalidation`               | Provides a promise scoped to the current cell evaluation.                            | Resolves when the cell reruns or its runtime is disposed.                                         |

Use `invalidation` to release resources owned by a cell. This fetch aborts when
one of its dependencies changes or the notebook closes.

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

## Python-owned variables

`variables` defines Python-owned names in the same graph. Updating a name
invalidates dependent cells while the widget stays mounted.

| Python API               | Effect                                               |
| ------------------------ | ---------------------------------------------------- |
| `update_variables(...)`  | Patches named values and reruns their dependents.    |
| `replace_variables(...)` | Replaces the Python-owned environment.               |
| `reset_variables(...)`   | Releases names so notebook cells can own them again. |

Runtime-owned names cannot be Python variables. `Notebook` raises `ValueError`
for known collisions, and the browser checks the active Notebook Kit library
before it starts the runtime. For example, `Plot`, `FileAttachment`, and `width`
belong to the browser runtime. See [Variable names](../reference/variables.md#variable-names)
for the complete list.

Imported ObservableHQ notebooks also reserve `require` for classic runtime
compatibility. Choose an application name such as `plot_rows` or
`selected_species` when passing a Python value that relates to a builtin.

Continue with [Python variables](python-variables.md) for live updates and
[cell values](cell-values.md) for browser-to-Python readback.
