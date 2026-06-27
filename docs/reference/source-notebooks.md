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
notebook = obs.Notebook.from_html(source, base_path="notebooks/report")
```

`source` must be a string. `base_path` resolves local files and relative
imports. `files` registers explicit Python file inputs and local paths are
normalized against `base_path`.

`embed_file_attachments=True` embeds local `FileAttachment` references.
`rewrite_imports=True` rewrites relative JavaScript imports to data URLs. Either
option requires `base_path`.

Explicit `files` override discovered files with the same name.

`source` values that are not strings raise `TypeError`. Unsupported Notebook Kit
theme attributes raise `ValueError`. Local attachments can raise
`FileNotFoundError` or `OSError` when files are missing or unreadable.

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

Creates a notebook from a Notebook Kit HTML file. The file parent is used as the
base path when embedding files or rewriting imports is enabled.

```python
notebook = obs.Notebook.from_html_file("notebooks/report.html")
```

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
document = json.loads(path.read_text())
notebook = obs.Notebook.from_observablehq_document(document)
```

Document `files` become URL-backed file records. Explicit `files` override
uploaded files with the same name.

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
page_data = json.loads(path.read_text())
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
notebook = obs.Notebook.from_observablehq_nodes(
    nodes,
    observable_files=files,
    title="Imported notebook",
)
```

ObservableHQ `js` nodes are imported with Observable JavaScript semantics.
Remote uploaded files become URL-backed file records. Explicit `files` override
uploaded files with the same name.

Unsupported document, page-data, or node shapes raise `TypeError` or
`ValueError`.
