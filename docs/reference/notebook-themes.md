---
title: Notebook themes
description: Notebook Kit theme names accepted by pyobservablejs.
---

# Notebook themes

`theme` accepts one Notebook Kit theme name.

```python
import observablejs as obs

notebook = obs.Notebook(..., theme="glacier")
```

It also accepts a light and dark mapping.

```python
notebook = obs.Notebook(
    ...,
    theme={"light": "cotton", "dark": "slate"},
)
```

`observablejs.NOTEBOOK_THEMES` is a tuple containing the accepted names:

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

Theme names are stripped and normalized to lowercase. Unknown names raise
`ValueError`. Mappings must contain exactly `light` and `dark`, with a valid
theme name for each value. Other value types raise `TypeError`.
