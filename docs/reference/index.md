---
title: Reference
description: Public Python API reference for pyobservablejs.
---

# Reference

The top-level public namespace is small.

```python
from observablejs import NOTEBOOK_THEMES, Notebook, html, js, md, ojs
```

Use these pages for supported signatures, defaults, synchronization behavior,
and error boundaries.

- [Notebook](notebook.md) covers construction, variables, source loading, and
  display lifecycle.
- [Cells](cells.md) covers `ojs`, `js`, `md`, and `html`.
- [Variables](variables.md) lists Python-to-Observable serialization.
- [Source notebooks](source-notebooks.md) covers `from_html` and
  `from_observablehq`.
- [Values and graph](values-and-graph.md) covers `NotebookCell` and graph
  metadata.
- [Notebook themes](notebook-themes.md) lists Notebook Kit themes.
