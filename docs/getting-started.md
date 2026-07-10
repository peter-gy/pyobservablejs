---
title: Getting started
description: Build and display a pyobservablejs notebook.
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
```

```{marimo} python
:echo: true

mo.ui.anywidget(notebook)
```

The full sample contains three species across three islands. Choosing a species
narrows both the bars and the legend.

## Follow the graph

`obs.Notebook(...)` creates the document. `obs.js(...)` adds standard JavaScript
cells. A top-level variable such as `species` can be referenced by another cell.

`view(...)` displays the select input and yields its current value. Changing the
selection invalidates the Plot cell, which runs again with the new value.

In marimo, display `mo.ui.anywidget(notebook)`. In Jupyter, put `notebook` as the
final expression in a cell.

## Next steps

- [Python data to Plot](examples/python-data-plot.md) passes records from Python.
- [Observable cells and reactivity](guides/author-cells.md) explains `obs.js`,
  `obs.ojs`, and cell dependencies.
- [Python variables](guides/python-variables.md) updates a mounted widget from a
  marimo control.
