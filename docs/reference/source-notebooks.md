---
title: Source notebooks
description: Notebook.from_html, Notebook.from_html_file, Notebook.from_observablehq, and ObservableHQ imports.
---

# Source notebooks

Source-backed notebooks use Notebook Kit HTML as their source.

## `Notebook.from_html`

```python
obs.Notebook.from_html(
    source,
    *,
    files=None,
    base_path=None,
    embed_file_attachments=False,
    rewrite_imports=False,
    variables=None,
    show_pinned_source=False,
)
```

Creates a notebook from a Notebook Kit HTML string.

```python
import observablejs as obs

source = """<!doctype html>
<notebook theme="air">
  <script id="1" type="application/vnd.observable.javascript">
    answer = 40 + 2
  </script>
</notebook>
"""

notebook = obs.Notebook.from_html(source)
```

`source` must be a string. `base_path` resolves local files and supplies the
base used when `rewrite_imports=True`. `files` registers explicit Python file
inputs and local paths are normalized against `base_path`.

`embed_file_attachments=True` registers existing local `FileAttachment`
references as data URLs.
`rewrite_imports=True` embeds existing local modules referenced by quoted
relative specifiers in static imports, `export ... from` declarations, and
dynamic `import(...)` calls. Computed specifiers and paths that do not resolve
to files stay unchanged. Either option requires `base_path`.

Explicit `files` override discovered files with the same name.
See [File attachments](file-attachments.md) for accepted `files` values,
construction-time data URLs, and discovery boundaries.

A non-string `source` raises `TypeError`. Unsupported Notebook Kit theme
attributes raise `ValueError`. Explicit local files can raise
`FileNotFoundError` or `OSError` when files are missing or unreadable. Import
rewriting raises `ValueError` for a circular local graph. Reading an imported
module can raise an `OSError` or `UnicodeError` subclass.

## `Notebook.from_html_file`

```python
obs.Notebook.from_html_file(
    path,
    *,
    files=None,
    embed_file_attachments=False,
    rewrite_imports=False,
    variables=None,
    show_pinned_source=False,
)
```

Creates a notebook from a Notebook Kit HTML file. The file parent resolves
relative explicit files, discovered attachments, and rewritten imports.

```python
import observablejs as obs

notebook = obs.Notebook.from_html_file("notebooks/report.html")
```

The file is read as UTF-8. Missing files raise `FileNotFoundError`. Read and
decode failures raise the corresponding `OSError` or `UnicodeError` subclass.

## `Notebook.from_observablehq`

```python
obs.Notebook.from_observablehq(
    specifier,
    *,
    variables=None,
    files=None,
    show_pinned_source=False,
    timeout=30,
)
```

Fetches a public ObservableHQ notebook through the document API.

```python
import observablejs as obs

notebook = obs.Notebook.from_observablehq("@d3/bar-chart", timeout=10)
```

The specifier may be an ObservableHQ URL, slug, notebook id, or document API URL.
Remote uploaded files become URL-backed attachments.

Invalid specifiers, non-JSON responses, unsupported document API shapes, and
conversion failures raise `ValueError`. HTTP and network failures raise
`OSError`.

## `Notebook.from_observablehq_document`

```python
obs.Notebook.from_observablehq_document(
    document,
    *,
    title=None,
    variables=None,
    files=None,
    show_pinned_source=False,
)
```

Creates a notebook from an already-fetched ObservableHQ document API mapping.

```python
import observablejs as obs

document = {
    "title": "Report",
    "nodes": [
        {"id": 1, "mode": "js", "name": "answer", "value": "answer = 42"}
    ],
}
notebook = obs.Notebook.from_observablehq_document(document)
```

Document `files` become URL-backed file records. Explicit `files` override
uploaded files with the same name. `title=None` uses the document title, then
falls back to `"Untitled"`.

## `Notebook.from_observablehq_page_data`

```python
obs.Notebook.from_observablehq_page_data(
    page_data,
    *,
    title=None,
    variables=None,
    files=None,
    show_pinned_source=False,
)
```

Creates a notebook from Observable page data with `initialNotebook`.

```python
import observablejs as obs

page_data = {
    "pageProps": {
        "initialNotebook": {
            "title": "Report",
            "nodes": [
                {"id": 1, "mode": "js", "value": "answer = 42"}
            ],
        }
    }
}
notebook = obs.Notebook.from_observablehq_page_data(page_data)
```

`page_data` must contain `pageProps.initialNotebook` or top-level
`initialNotebook`.

## `Notebook.from_observablehq_nodes`

```python
obs.Notebook.from_observablehq_nodes(
    nodes,
    *,
    observable_files=None,
    title="Untitled",
    variables=None,
    files=None,
    show_pinned_source=False,
)
```

Creates a notebook from ObservableHQ node records and optional file records.

```python
import observablejs as obs

nodes = [
    {"id": 1, "mode": "js", "name": "answer", "value": "answer = 42"}
]
notebook = obs.Notebook.from_observablehq_nodes(
    nodes,
    title="Imported notebook",
)
```

ObservableHQ `js` nodes are imported with Observable JavaScript semantics.
Remote uploaded files become URL-backed file records. Explicit `files` override
uploaded files with the same name.

The resulting records follow the contract described in
[File attachments](file-attachments.md).

Unsupported document, page-data, or node shapes raise `TypeError` or
`ValueError`.

## Imported runtime compatibility

ObservableHQ documents can depend on helpers from the classic Observable
runtime. Imported cells receive these compatibility behaviors:

| Behavior                                     | Contract                                                                                                                                                 |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `require`                                    | Resolves npm package specifiers through jsDelivr, supports `require.resolve`, `require.alias`, preloaded aliases, multiple loads, and default promotion. |
| `Mutable`                                    | Keeps Notebook Kit's async mutable generator with a `.value` setter and adds a `generator` alias for older code.                                         |
| `Generators.observe`, `.queue`, and `.input` | Keep Notebook Kit's async generator shape and expose a sync iterator for older consumers.                                                                |
| `html`                                       | Accepts simple form and text markup in legacy string interpolations. Event handlers, URL attributes, inline styles, and other tags stay as text.         |
| notebook-defined `display` and `view`        | Lets cells call variables named `display` or `view` when the notebook defines those variables.                                                           |
