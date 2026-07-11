---
title: Files and source notebooks
description: Load Notebook Kit HTML with local FileAttachment files.
---

# Files and source notebooks

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

base = Path(tempfile.mkdtemp(prefix="observable-source-"))
(base / "penguins.csv").write_text(
    "species,count\nAdelie,152\nChinstrap,68\nGentoo,124\n",
    encoding="utf-8",
)

source = """
<notebook theme="glacier">
  <script type="module">
const penguinCounts = FileAttachment("penguins.csv").csv({typed: true});
  </script>
  <script type="module">
Plot.barY(penguinCounts, {x: "species", y: "count", fill: "species", tip: true}).plot({
  height: 260,
  color: {legend: true},
  y: {grid: true, label: "Penguins"}
})
  </script>
</notebook>
"""
(base / "penguins.html").write_text(source, encoding="utf-8")

notebook = obs.Notebook.from_html_file(
    base / "penguins.html",
    embed_file_attachments=True,
)
full_view = notebook.view()
mo.ui.anywidget(full_view)
```

The output renders species counts from the local CSV. The counts come from the
[Palmer Penguins dataset](https://allisonhorst.github.io/palmerpenguins/).

## File and import options

`embed_file_attachments=True` discovers local `FileAttachment("...")`
references in notebook script cells. `rewrite_imports=True` embeds existing
local modules referenced by quoted relative specifiers in static imports,
`export ... from` declarations, and dynamic `import(...)` calls. Computed
specifiers and paths that do not resolve to files stay unchanged. Both options
require a `base_path` for `from_html` because a source string has no filesystem
owner.

Import rewriting follows quoted local imports recursively. Circular local
graphs raise `ValueError`. Module read and decode failures raise the
corresponding `OSError` or `UnicodeError` subclass.

Leave both options false when the frontend page already serves the referenced
files at the same relative paths.

```python
notebook = obs.Notebook.from_html(source)
```

Explicit `files` override discovered files with the same name.

```python
notebook = obs.Notebook.from_html(
    source,
    base_path=base,
    files={"penguins.csv": "https://example.test/penguins.csv"},
)
```
