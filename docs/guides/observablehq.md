---
title: ObservableHQ imports
description: Fetch public ObservableHQ notebooks and override variables.
---

# ObservableHQ imports

`Notebook.from_observablehq` fetches a public ObservableHQ notebook through the
document API and returns a `Notebook` you can display like any Python-authored
notebook.

The constructor performs a network request. For reproducible builds and tests,
store the document data separately and pass it to
[`Notebook.from_observablehq_document(...)`](../reference/source-notebooks.md#notebook-from-observablehq-document).

```python
import observablejs as obs

notebook = obs.Notebook.from_observablehq("@observablehq/plot-scatterplot/2")
```

The `specifier` can be an ObservableHQ URL, a notebook slug, a notebook id, or a
document API URL.

```python
obs.Notebook.from_observablehq("https://observablehq.com/@d3/bar-chart")
obs.Notebook.from_observablehq("@d3/bar-chart")
```

Pass `variables` to override notebook variables from Python.

```python
penguins = [
    {"culmen_length_mm": 36.7, "culmen_depth_mm": 18.4},
    {"culmen_length_mm": 44.1, "culmen_depth_mm": 15.9},
    {"culmen_length_mm": 50.2, "culmen_depth_mm": 19.1},
]

notebook = obs.Notebook.from_observablehq(
    "@observablehq/plot-scatterplot/2",
    variables={"penguins": penguins},
)
```

Remote uploaded files become URL-backed file records. Explicit `files` override
fetched files with the same name.

```python
notebook = obs.Notebook.from_observablehq(
    "@example/notebook",
    files={"data.csv": "https://example.test/data.csv"},
)
```

## Errors

Invalid specifiers, non-JSON responses, unsupported document API shapes, and
conversion failures raise `ValueError`. HTTP and network failures raise
`OSError`. Use `timeout` to bound the request.

```python
notebook = obs.Notebook.from_observablehq("@d3/bar-chart", timeout=10)
```

See [Source notebooks](../reference/source-notebooks.md) for document-shaped
constructors and imported runtime compatibility.
