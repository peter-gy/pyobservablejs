---
title: ObservableHQ imports
description: Fetch public ObservableHQ notebooks and override variables.
---

# ObservableHQ imports

`Notebook.from_observablehq` fetches a public ObservableHQ notebook through the
document API and returns a `Notebook` you can display like any Python-authored
notebook.

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

## Legacy runtime compatibility

Imported ObservableHQ notebooks can depend on older Observable runtime helpers.
The browser runtime layers these behaviors over Notebook Kit when a source
notebook asks for them:

| Behavior                                     | Contract                                                                                                                                                 |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `require`                                    | Resolves npm package specifiers through jsDelivr, supports `require.resolve`, `require.alias`, preloaded aliases, multiple loads, and default promotion. |
| `Mutable`                                    | Keeps Notebook Kit's async mutable generator with a `.value` setter and adds a `generator` alias for older code.                                         |
| `Generators.observe`, `.queue`, and `.input` | Keep Notebook Kit's async generator shape and expose a sync iterator for older consumers.                                                                |
| `html`                                       | Accepts simple form and text markup in legacy string interpolations. Event handlers, URL attributes, inline styles, and other tags stay as text.         |
| notebook-defined `display` and `view`        | Lets cells call variables named `display` or `view` when the notebook defines those variables.                                                           |

## Errors

Invalid specifiers, non-JSON responses, unsupported document API shapes, and
conversion failures raise `ValueError`. HTTP and network failures raise
`OSError`. Use `timeout` to bound the request.

```python
notebook = obs.Notebook.from_observablehq("@d3/bar-chart", timeout=10)
```

Keep remote imports out of reproducible docs builds and tests unless the network
request is mocked.
