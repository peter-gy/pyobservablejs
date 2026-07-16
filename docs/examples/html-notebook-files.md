---
title: Load notebook HTML
description: Render an existing Notebook Kit HTML document from Python.
---

# Load notebook HTML

`Notebook.from_html` loads an existing Notebook Kit document. The source can
use Notebook Kit cells and built-in libraries directly. The example uses
Notebook Kit's built-in AAPL sample.

The browser loads Plot and the sample data used here. See [Notebook
runtime](../guides/notebook-runtime.md#builtins) for network and content
security policy requirements.

Load HTML only from sources you trust. Notebook cells execute JavaScript and
can load remote modules or data.

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
<notebook theme="glacier">
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
full_view = notebook.view()
mo.ui.anywidget(full_view)
```

The widget preserves the `glacier` theme and renders the built-in AAPL sample
as an area chart.

Use `Notebook.from_html_file(...)` for a document on disk. It uses the
document's parent directory as its base path. Enable `embed_file_attachments`
and `rewrite_imports` when local assets must travel with the widget.

## Continue

- Use [Files and source notebooks](../guides/source-html.md) to embed local
  `FileAttachment` files.
- [Source notebooks](../reference/source-notebooks.md) gives the complete
  constructor contract.
