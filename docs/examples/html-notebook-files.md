---
title: HTML notebook files
description: Load Notebook Kit HTML and a local CSV attachment.
---

# HTML notebook files

This example writes a CSV file, loads a Notebook Kit HTML string, and asks
`Notebook.from_html` to embed the file.

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
(base / "traffic.csv").write_text(
    "source,visits\nsearch,1200\nemail,640\nsocial,380\n",
    encoding="utf-8",
)

source = """
<notebook theme="air">
  <script id="1" name="traffic" type="application/vnd.observable.javascript">
traffic = FileAttachment("traffic.csv").csv({typed: true})
  </script>
  <script id="2" name="chart" type="application/vnd.observable.javascript">
Plot.plot({
  height: 220,
  marginLeft: 52,
  y: {grid: true},
  marks: [
    Plot.barY(traffic, {x: "source", y: "visits", tip: true})
  ]
})
  </script>
</notebook>
"""

notebook = obs.Notebook.from_html(
    source,
    base_path=base,
    embed_file_attachments=True,
)
mo.ui.anywidget(notebook)
```

The notebook renders bars from `traffic.csv`. `embed_file_attachments=True`
discovers the local file attachment relative to `base_path`.

The file is discovered from the executable `FileAttachment("traffic.csv")`
expression. Text that merely mentions `FileAttachment` in Markdown is ignored.

## Continue

- [Source notebooks](../reference/source-notebooks.md) gives the `from_html`
  contract.
- [Variables](../reference/variables.md) covers when to use variables instead of
  file attachments.
