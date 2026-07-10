---
title: Load notebook HTML
description: Render an existing Notebook Kit HTML document from Python.
---

# Load notebook HTML

`Notebook.from_html` turns an existing Notebook Kit document into a
`pyobservablejs` widget. The source can use Notebook Kit cells and built-in
libraries directly. This document uses Notebook Kit's built-in AAPL sample.

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

source = """
<notebook theme="air">
  <script type="text/markdown">
# Apple closing price
  </script>
  <script type="module">
Plot.areaY(aapl, {x: "Date", y: "Close", tip: true}).plot({
  height: 280,
  y: {grid: true, label: "Close ($)"}
})
  </script>
</notebook>
"""

notebook = obs.Notebook.from_html(source)
mo.ui.anywidget(notebook)
```

The widget preserves the document theme and renders the built-in AAPL sample as
an area chart. The JavaScript remains a standard Notebook Kit module cell.

Use `Notebook.from_html_file(...)` for a document on disk. Local attachments and
relative imports need a base path and their corresponding rewrite options.

## Continue

- [Source HTML](../guides/source-html.md) embeds local `FileAttachment` files.
- [Source notebooks](../reference/source-notebooks.md) gives the complete
  constructor contract.
