---
title: Getting started
description: Build a pyobservablejs notebook and render a view.
---

# Getting started

Install `pyobservablejs` with a notebook frontend. Python 3.11 or newer is
required.

```sh
pip install pyobservablejs jupyterlab
jupyter lab
```

For marimo, install and start an editable notebook:

```sh
pip install pyobservablejs marimo
marimo edit first.py
```

## Build a live notebook

This notebook combines a Notebook Kit input with an Observable Plot chart. Try
choosing a species. The grouped counts recompute in the browser. `penguins` is a
sample dataset provided by Notebook Kit.

The browser loads `Inputs`, `Plot`, and `penguins` from jsDelivr. It needs
network access and a content security policy that permits the CDN requests.

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
```

```{marimo} python
:echo: true

notebook = obs.Notebook(
    obs.md("## Penguins by island"),
    obs.js(
        """
        const species = view(Inputs.select(
          ["All", ...new Set(penguins.map((d) => d.species))],
          {label: "Species", value: "All"}
        ));
        """,
        key="species_control",
    ),
    obs.js(
        """
        Plot.barY(
          species === "All"
            ? penguins
            : penguins.filter((d) => d.species === species),
          Plot.groupX(
            {y: "count"},
            {x: "island", fill: "species", tip: true}
          )
        ).plot({
          height: 280,
          color: {legend: true},
          x: {label: "Island"},
          y: {grid: true, label: "Penguins"}
        })
        """,
        key="island_counts",
    ),
)

full_view = notebook.view()
```

```{marimo} python
:echo: true

mo.ui.anywidget(full_view)
```

The full sample contains three species across three islands. Choosing a species
narrows both the bars and the legend.

## Follow the graph

`obs.Notebook(...)` stores the cells and shared variables. `notebook.view()`
selects every cell and returns a `NotebookView`. Browser evaluation starts when
marimo mounts that view through `mo.ui.anywidget`. `obs.js(...)` adds standard
JavaScript cells, and top-level variables can be referenced by other cells.

Inside the JavaScript cell, `view(...)` displays the select input and yields its
current value. Changing the selection invalidates the Plot cell, which runs
again with the new value.

In marimo, wrap `full_view` with `mo.ui.anywidget`. In Jupyter, put `full_view`
as the final expression in a cell.

## Next steps

- [Python data to Plot](examples/python-data-plot.md) passes records from Python.
- [Observable cells and reactivity](guides/author-cells.md) explains `obs.js`,
  `obs.ojs`, and cell dependencies.
- [Views and composition](guides/views-and-composition.md) explains full,
  focused, and composite views.
- [Python variables](guides/python-variables.md) updates a mounted view from a
  marimo control.
