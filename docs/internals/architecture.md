---
title: Architecture
description: Browser-first runtime architecture for pyobservablejs.
---

# Architecture

`pyobservablejs` is browser-first. Python owns the notebook model. The browser
evaluates Observable JavaScript through Notebook Kit and synchronizes values
back through anywidget traits.

```text
Python Notebook
  cells, variables, attachments, options
        |
        v
anywidget trait model
        |
        v
TypeScript renderer
        |
        v
Notebook Kit runtime
        |
        v
cell values and graph metadata
        |
        v
Python NotebookCell and NotebookGraph views
```

## Render lifecycle

1. Python creates a `Notebook` from authored cells, Notebook Kit HTML, or an
   ObservableHQ document.
2. The widget model sends source, specs, attachments, variables, and child cell
   widget references through traitlets.
3. The TypeScript renderer resolves child models from the anywidget host.
4. Notebook Kit parses or transpiles the notebook and creates the Observable
   runtime.
5. The browser renders cell outputs and syncs graph metadata.
6. Runtime values sync to `NotebookCell.values` and `Notebook.runtime_values`.
7. Teardown disposes the browser runtime and child views owned by that render.

## Variable updates

`update_variables` sends a patch. The frontend applies the patch to the live
runtime. `replace_variables` sends a full replacement and releases names omitted
from the replacement.

`viewof` cells are browser-owned. Python can override a variable with the same
name, and the frontend writes the value through the runtime path used by
Observable inputs.

## Source-backed notebooks

`from_html` keeps Notebook Kit HTML as source. Portable mode embeds local
attachments and rewrites local imports before the source reaches the browser.

`from_observablehq` fetches public notebooks and converts document API cells into
Notebook Kit HTML before using the same source-backed rendering path.
