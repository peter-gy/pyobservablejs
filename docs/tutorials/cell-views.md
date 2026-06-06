---
title: Cell Values
description: Read one Observable cell through its NotebookCell handle.
---

# Cell Values

Name a cell when Python needs to read its synchronized value or graph metadata.
Display the parent `Notebook` to render Observable outputs.

```python
import pyobservablejs as obs

notebook = obs.Notebook(
    obs.ojs('viewof gain = Inputs.range([0, 11], {value: 5})', name="gain"),
    obs.ojs("double = gain * 2", name="double"),
)

notebook
```

Read synchronized values from a later Python cell:

```python
gain = notebook.cell("gain")

gain.value
notebook.value("double")
```

The `NotebookCell` handle exposes values and graph metadata for its matching
cell:

```python
gain.values
gain.info
gain.defines
gain.references
```

`NotebookCell.values` contains JSON-compatible values synchronized through
anywidget traits. DOM nodes such as controls, SVG, canvas, and figures stay in
the browser output owned by the parent notebook.
