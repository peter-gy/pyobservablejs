---
title: Variables
description: Python value serialization for Observable variables.
---

# Variables

`variables` and variable update methods accept a mapping from JavaScript
identifier names to Python values.

```python
notebook = obs.Notebook(
    obs.ojs("md`threshold is ${threshold}`"),
    variables={"threshold": 0.75},
)
```

Variable names must be valid JavaScript identifiers. Values are serialized into
the widget trait state.

| Python value                               | Observable value      |
| ------------------------------------------ | --------------------- |
| `None`                                     | `null`                |
| `bool`, `str`, safe `int`, `float`         | JSON primitives       |
| `float("nan")`, infinities                 | Tagged numeric values |
| Integers outside the safe JavaScript range | `BigInt`              |
| `datetime.date`, `datetime.datetime`       | `Date`                |
| `bytes`, `bytearray`, `memoryview`         | Byte arrays           |
| `dict`, `list`, `tuple`, `range`           | Objects and arrays    |
| pandas and Polars dataframes               | Row records           |
| pandas and Polars series                   | Arrays                |
| NumPy arrays and scalars                   | Lists and scalars     |

Unsupported values raise `TypeError` before the widget is displayed.

## Updates

```python
notebook.update_variables(threshold=0.9)
notebook.replace_variables({"rows": rows})
notebook.reset_variables("threshold")
```

`update_variables` patches names. `replace_variables` replaces the full
environment. `reset_variables` releases names that Python owns.

For large data, pass a file through `FileAttachment` and use variables for
selection, thresholds, labels, and other small interactive state.
