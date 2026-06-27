---
title: Notebook themes
description: Notebook Kit theme names accepted by pyobservablejs.
---

# Notebook themes

`theme` accepts one Notebook Kit theme name.

```python
notebook = obs.Notebook(..., theme="glacier")
```

It also accepts a light and dark mapping.

```python
notebook = obs.Notebook(
    ...,
    theme={"light": "cotton", "dark": "slate"},
)
```

`observablejs.NOTEBOOK_THEMES` contains the accepted names:

```python
(
    "air",
    "coffee",
    "cotton",
    "deep-space",
    "glacier",
    "ink",
    "midnight",
    "near-midnight",
    "ocean-floor",
    "parchment",
    "slate",
    "stark",
    "sun-faded",
)
```

Unknown theme names raise `ValueError`. Mappings must contain exactly `light`
and `dark`.
