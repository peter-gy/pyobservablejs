---
title: Variables
description: Variable names, Python-to-browser serialization, updates, and browser readback conversion.
---

# Variables

`variables` defines Python-owned values in the Observable runtime. Values are
serialized recursively and preserve the supported browser types with tagged
records where JSON has no direct equivalent.

```python
import observablejs as obs

notebook = obs.Notebook(
    obs.ojs("md`threshold is ${threshold}`"),
    variables={"threshold": 0.75},
)
```

## Variable names

Names must match this ASCII JavaScript identifier pattern:

```text
^[A-Za-z_$][0-9A-Za-z_$]*$
```

The Observable runtime owns these names, so Python variables cannot use them:

```text
Arrow DOM DatabaseClient DuckDBClient FileAttachment Files Generators Inputs
Interpreter L Mutable Plot Promises React ReactDOM SQLite SQLiteDatabaseClient
_ __ojs_observer aapl alphabet aq cars citywages d3 dark diamonds document dot
duckdb echarts flare htl html industries mapboxgl md mermaid miserables now
olympians penguins pizza svg tex topojson vl weather width
```

ObservableHQ imports also reserve `require` while their classic runtime
compatibility helpers are active. Invalid identifiers and reserved names raise
`ValueError` during construction or a variable update.

## Python to browser

| Python input                                                        | Observable value               | Boundary                                                                         |
| ------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------- |
| `None`                                                              | `null`                         | Plain JSON                                                                       |
| `bool`, `str`                                                       | `boolean`, `string`            | Plain JSON                                                                       |
| `int` from `-9_007_199_254_740_991` through `9_007_199_254_740_991` | `number`                       | Inclusive JavaScript safe-integer range                                          |
| `int` outside the safe-integer range                                | `BigInt`                       | Decimal text in a tagged record                                                  |
| Finite `float`                                                      | `number`                       | Plain JSON                                                                       |
| `float("nan")`, positive infinity, negative infinity                | `NaN`, `Infinity`, `-Infinity` | Tagged record                                                                    |
| `datetime.date`, `datetime.datetime`                                | `Date`                         | Python `isoformat()` text passed to the JavaScript `Date` constructor            |
| `bytes`, `bytearray`, `memoryview`                                  | `Uint8Array`                   | Base64 in a tagged record                                                        |
| `Mapping`                                                           | Plain object                   | Keys converted with `str`, values converted recursively                          |
| `range`                                                             | Array                          | Materialized directly. Elements should stay in the JavaScript safe-integer range |
| `list`, `tuple`, and other iterables                                | Array                          | Materialized and converted recursively                                           |
| pandas or Polars `DataFrame`                                        | Array of row objects           | pandas uses `to_dict(orient="records")`, Polars uses `to_dicts()`                |
| pandas or Polars `Series`                                           | Array                          | pandas uses `tolist()`, Polars uses `to_list()`                                  |
| NumPy array or scalar                                               | Array or scalar                | Uses `tolist()` or `item()`, then converts the result recursively                |

One-shot iterators such as generators are materialized once and stored as
replayable lists. Mapping keys with the same string form collapse to one
JavaScript property. A mapping that contains `__observablejs_type__` is wrapped
on the wire and revived as an ordinary user object.

`range` uses direct JSON number encoding. Elements outside the JavaScript
safe-integer range can lose precision in the browser. Use a list when those
elements need `BigInt` conversion.

Values outside these contracts raise `TypeError` before display. Use
[file attachments](file-attachments.md) for large tables and binary data that
the browser can load through `FileAttachment`.

## `Notebook.variables`

```python
current = notebook.variables
```

Returns a shallow copy of the current Python-owned variable mapping. Browser
evaluation and readback remain separate from this mapping.

## Python values and `viewof` inputs

When a Python variable has the same name as a `viewof` input, the initial
Python value seeds the control. A browser interaction then becomes shared
session input state for current and future views.

An `update_variables` or `replace_variables` call that includes the name clears
the interacted value and applies the Python value to every active view. This
also reasserts a configured Python value that has not changed in Python.
Releasing the name through `replace_variables` or `reset_variables` restores
the source-defined input default.

## `Notebook.update_variables(values=None, /, **kwargs)`

```python
notebook.update_variables({"threshold": 0.8}, label="selected")
```

Merges a mapping or iterable of key-value pairs into the Python-owned
environment. Keyword arguments are applied after `values` and win when a name
appears in both. Active views receive a live `set` update. An empty update is a
no-op.

The method returns `None`. Invalid names raise `ValueError`. A malformed
key-value iterable or unsupported value raises `TypeError`.

## `Notebook.replace_variables(values=None, /, **kwargs)`

```python
notebook.replace_variables({"rows": rows})
```

Replaces the complete Python-owned environment and returns `None`. Names absent
from the replacement are released. Active views rebuild their runtimes, which
restores notebook definitions for released names. Keyword arguments win over
matching entries in `values`.

## `Notebook.reset_variables(*names)`

```python
notebook.reset_variables("threshold", "label")
```

Releases the listed names when Python currently owns them and returns `None`.
An empty call and names outside the current environment are no-ops. Releasing
at least one name follows the replacement lifecycle and restores the original
notebook definitions in each active runtime.

## Browser to Python readback

`NotebookView.runtime_values`, `NotebookView.value`, and
`NotebookView.cell_values()` decode browser values back to Python after the
view renders. See [`NotRenderedError`](values-and-graph.md#notrenderederror) for
the required lifecycle state.

| Browser value                               | Python readback                                             |
| ------------------------------------------- | ----------------------------------------------------------- |
| `undefined`, `null`                         | `None`                                                      |
| Boolean, string, finite number              | `bool`, `str`, `int` or `float` supplied by JSON decoding   |
| `NaN`, positive infinity, negative infinity | Python `float` special value                                |
| `BigInt`                                    | `int`                                                       |
| Valid `Date`                                | `datetime.datetime`                                         |
| Array                                       | `list`                                                      |
| Plain object                                | `dict` containing own enumerable data properties            |
| `Map`                                       | `list` of key-value tuples                                  |
| `Set`                                       | `list`                                                      |
| `ArrayBuffer`, typed array, or `DataView`   | `bytes`                                                     |
| DOM element                                 | String such as `"<div>"`                                    |
| Function                                    | String such as `"[Function update]"`                        |
| `Symbol`                                    | Tagged dictionary containing `"symbol"` and its string form |
| `Error`                                     | String such as `"TypeError: invalid value"`                 |
| `RegExp`                                    | String form of the expression                               |
| `File`                                      | `{"name": ..., "size": ..., "mime_type": ...}`              |
| `Blob`                                      | `{"size": ..., "mime_type": ...}`                           |
| Circular reference                          | String such as `"[Circular reference 1]"`                   |

Readback summarizes a value when traversal reaches a depth of 100 or 50,000
container nodes. The summary is a string such as `"Array(10)"`, `"Map(3)"`, or
the object's constructor name. Detached array buffers and invalid dates also
return summary strings. Typed-array class and map or set container identity are
therefore absent from the Python readback value.
