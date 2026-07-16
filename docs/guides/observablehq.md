---
title: ObservableHQ imports
description: Fetch public ObservableHQ notebooks and override variables.
---

# ObservableHQ imports

`Notebook.from_observablehq` fetches a public ObservableHQ notebook through the
document API and returns a `Notebook` definition. Call `view()` to create its
renderable view. Imported cells run with the classic Observable standard
library, including `require`, `html`, `Generators`, `Mutable`, and `DOM`.

Treat imported notebooks as executable code. Their cells run JavaScript in the
notebook page and can load remote modules or data.

The constructor performs a network request. To avoid fetching the top-level
document during a build or test, store its complete data, including `id` and
`version`, and pass it to
[`Notebook.from_observablehq_document(...)`](../reference/source-notebooks.md#notebook-from-observablehq-document).
Imports, uploaded files, libraries, and datasets may still require network
access when the view renders.

```python
import observablejs as obs

notebook = obs.Notebook.from_observablehq("@observablehq/plot-scatterplot/2")
full_view = notebook.view()
full_view
```

The `specifier` can be an ObservableHQ URL, a notebook slug, a notebook id, or a
document API URL.

```python
obs.Notebook.from_observablehq("https://observablehq.com/@d3/bar-chart")
obs.Notebook.from_observablehq("@d3/bar-chart")
```

## Keep imported notebooks pinned

The fetched document identifies its source revision. `pyobservablejs` uses that
revision when resolving imported Observable notebooks, so their dependency
versions match the source notebook.

Keep `id` and `version` when saving a document API response. Passing the saved
mapping to `from_observablehq_document` restores the same import resolution.
Use `from_observablehq_nodes` for node collections whose imports should resolve
from the specifiers stored in those nodes.

Pass `variables` to override notebook variables from Python.

```python
document = {
    "id": "1234567890abcdef",
    "version": 7,
    "title": "Report",
    "nodes": [
        {"id": 1, "mode": "js", "name": "answer", "value": "answer = 42"},
        {"id": 2, "mode": "js", "value": "md`Answer: ${answer}`"},
    ],
}
notebook = obs.Notebook.from_observablehq_document(
    document,
    variables={"answer": 100},
)
```

Remote uploaded files become URL-backed file records. Explicit `files` override
fetched files with the same name.

## Errors

Invalid specifiers, non-JSON responses, unsupported document API shapes, and
conversion failures raise `ValueError`. Response text decoding failures raise
`UnicodeError`. HTTP and network failures raise `OSError`. Use `timeout` to
bound the request.

```python
notebook = obs.Notebook.from_observablehq("@d3/bar-chart", timeout=10)
```

See [Source notebooks](../reference/source-notebooks.md) for document-shaped
constructors and source-revision import resolution.
