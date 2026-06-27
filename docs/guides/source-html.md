---
title: Source HTML
description: Load Notebook Kit HTML and local FileAttachment files.
---

# Source HTML

`Notebook.from_html_file` loads Notebook Kit HTML files. Set
`embed_file_attachments=True` to embed local `FileAttachment` calls and
`rewrite_imports=True` to inline relative JavaScript imports.

```{marimo-config}
:pyproject:

  requires-python = ">=3.11"
  dependencies = [
      "pyobservablejs",
  ]
```

```{marimo} python
:echo: true

from pathlib import Path
import tempfile

import marimo as mo
import observablejs as obs

base = Path(tempfile.mkdtemp(prefix="pyobservablejs-docs-"))
(base / "orders.csv").write_text(
    "region,revenue\nwest,42\neast,31\ncentral,27\n",
    encoding="utf-8",
)

source = """
<notebook theme="glacier">
  <script id="1" name="orders" type="application/vnd.observable.javascript">
orders = FileAttachment("orders.csv").csv({typed: true})
  </script>
  <script id="2" name="chart" type="application/vnd.observable.javascript">
Plot.plot({
  height: 220,
  marginLeft: 52,
  y: {grid: true},
  marks: [
    Plot.barY(orders, {x: "region", y: "revenue", tip: true})
  ]
})
  </script>
</notebook>
"""
(base / "orders.html").write_text(source, encoding="utf-8")

notebook = obs.Notebook.from_html_file(
    base / "orders.html",
    embed_file_attachments=True,
    rewrite_imports=True,
)
mo.ui.anywidget(notebook)
```

The output renders a `glacier` themed bar chart with `west`, `east`, and
`central` bars from `orders.csv`. Hover a bar to see the revenue.

## File and import options

`embed_file_attachments=True` discovers local `FileAttachment("...")`
references in notebook script cells. `rewrite_imports=True` rewrites relative
JavaScript imports to data URLs. Both options require a `base_path` for
`from_html` because a source string has no filesystem owner.

Leave both options false when the frontend page already serves the referenced
files at the same relative paths.

```python
notebook = obs.Notebook.from_html(
    source,
    base_path=base,
)
```

Explicit `files` override discovered files with the same name.

```python
notebook = obs.Notebook.from_html(
    source,
    base_path=base,
    files={"orders.csv": "https://example.test/orders.csv"},
)
```
