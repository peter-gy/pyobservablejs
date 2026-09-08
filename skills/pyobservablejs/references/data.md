# Inspect source and extract data

Use [SKILL.md](../SKILL.md) for the starter chart and
[hosts.md](hosts.md) for executing browser requests. Keep source metadata,
preview values, and full data reads distinct. Python snapshots and decoded read
containers use read-only mappings and tuples. Index or iterate them directly,
and use Arrow bytes for a portable table artifact.

## Choose the representation

| Need                                                              | Object                                                    |
| ----------------------------------------------------------------- | --------------------------------------------------------- |
| Python inputs and declared attachments                            | `notebook.state`                                          |
| Prepared cell source and stable handles, before browser execution | `notebook.cells`, `notebook.cell(key)`                    |
| Original ObservableHQ records                                     | `notebook.source_document`                                |
| Full source analysis, imports, files, and dependency graph        | `view.inspection`                                         |
| Selected cell previews and evaluation revisions                   | `view.state`                                              |
| Materialized dataset metadata                                     | `view.datasets`                                           |
| Exact value, projected table, or attachment bytes                 | `await view.read(...)`, `await view.read_attachment(...)` |

`source_document` is populated for Observable document imports. It is `None`
for Python-authored and plain HTML notebooks. Imported node data can expand
into several prepared cells. Retain document id/version and original node
records for provenance rather than matching cells by positional assumptions.

`view.inspection` starts as `None` until the browser publishes metadata. It
covers the full definition, including static analysis errors, files, databases,
secrets, imports, bindings, and injections. Listing a secret reference provides
its name, not its value.

## List datasets

```python
[
    {
        "cell": dataset.cell.key,
        "index": dataset.cell.index,
        "name": dataset.name,
        "kind": dataset.kind,
        "rows": dataset.row_count,
        "columns": [
            (column.name, column.type, column.nullable) for column in dataset.columns
        ],
        "schema_source": dataset.schema_source,
        "sampled_rows": dataset.sampled_rows,
    }
    for dataset in view.datasets
]
```

An empty catalog can mean evaluation is pending or no evaluated values are
recognized tables. The catalog covers the evaluated selection and its hidden
dependencies. It does not execute unrelated cells just to discover their data.
Kinds include Arrow, Arquero, row arrays, and scalar arrays. Array metadata can
come from declared schema or a bounded sample. Inspect `schema_source` and
`sampled_rows`, then validate actual data beyond the metadata when needed.

## Select the right value

| Selection                            | Example                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------- |
| JavaScript variable name             | `await view.read("visible", format="rows")`                               |
| Output of a canonical cell           | `await view.read(notebook.cell("chart"), name="rowCount", format="json")` |
| Anonymous imported output            | `await view.read(notebook.cells[index], format="json")`                   |
| A particular listed dataset revision | `await view.read(dataset, columns=["value"], limit=100)`                  |

`index` in the imported example comes from inspecting `notebook.cells`, and
`dataset` is a descriptor just obtained from this view. A string is a variable
name, even when it happens to equal a cell key. Cells with several outputs need
`name=`. Read a named control's value by its JavaScript name, such as `threshold`.
`runtime_outputs` also lists raw names such as `viewof$threshold` when tracing
the graph. Inspect the control DOM in the browser.

A selector can only read values in the evaluated selection or dependency
closure. Create and display a view that includes the producing cell when the
value is outside that scope. Use a fresh descriptor after updates. A descriptor
from another view is invalid, and one from a replaced runtime is stale.

## Project, export, and decode

For the starter chart:

```python
export = await view.read("visible", columns=["category", "value"], limit=1000)
```

The default format is [Apache Arrow](https://arrow.apache.org/) IPC, a binary
columnar table representation. `export.data` contains bytes. Decode them with
the optional `pyarrow` package:

```python
table = export.to_arrow()
print(table.column_names, table.num_rows)
```

Use `format="rows"` for detached Python records, `format="json"` for supported
scalar/structured values, and `format="bytes"` for raw binary values. Arrow and
rows formats require a dataset. DOM nodes and functions belong in browser
inspection, not a Python JSON export. `to_arrow()` requires an Arrow read.

`columns`, `offset`, and `limit` select a smaller table. `path=["records"]`
traverses a nested own data property before projection. Accessor properties are
rejected. Byte reads do not accept row ranges or column projections.

```python
from pathlib import Path

Path("visible.arrow").write_bytes(export.data)
```

`NotebookRead` also records its producing cell, name, revision, format, dataset
description, and MIME type. A descriptor pins one materialized revision. A
name-based read waits for the currently evaluated value. Reads reject on
relevant lifetime/revision changes rather than silently switching views.

Notebook Kit SQL can return native Arrow tables. The classic Observable import
profile follows upstream row-array behavior. Inspect `notebook.runtime_profile`
and dataset kind before assuming that a notebook value supports array methods
such as `.map()`.

## Read attachments and preserve source

For a notebook declaring `rows.csv`:

```python
payload = await view.read_attachment("rows.csv")
```

This returns exact bytes fetched in the browser, subject to its networking and
permissions. Attachment metadata alone does not establish a successful fetch.

`notebook.to_notebook_html()` exports the Notebook Kit definition. Python
variables and local attachment bytes remain session state, so HTML alone is
not a bundle of the current evaluated chart and all its inputs. Preserve those
inputs separately when reproducibility requires them.

JSON previews can summarize large values and unsupported object types. They
are for inspection, not full dataset export. Use Arrow and narrow projections
for bulk transfer. All async examples use a later Jupyter cell or the marimo
handoff described in [hosts.md](hosts.md#browser-requests-in-marimo).
