---
title: Themes
description: Apply Notebook Kit themes and source panels.
---

# Themes

`theme` accepts a Notebook Kit theme name or a light and dark mapping. Pinned
cells appear in the source panel when `show_pinned_source=True`.

```{marimo-config}
:pyproject:

  requires-python = ">=3.11"
  dependencies = [
      "pyobservablejs",
  ]
```

```{marimo} python
:echo: true

import marimo as mo
import observablejs as obs

notebook = obs.Notebook(
    obs.md("# Source panel"),
    obs.ojs("answer = 40 + 2", key="answer_cell", pinned=True),
    obs.ojs("md`The answer is **${answer}**`", key="readout"),
    theme={"light": "cotton", "dark": "slate"},
    show_pinned_source=True,
)

mo.ui.anywidget(notebook)
```

The rendered notebook uses the selected theme, and the pinned `answer = 40 + 2`
source appears because `show_pinned_source=True`.

## Theme names

Use one of the theme names exposed by `observablejs.NOTEBOOK_THEMES`.

```python
import observablejs as obs

obs.NOTEBOOK_THEMES
```

Available names:

`air`, `coffee`, `cotton`, `deep-space`, `glacier`, `ink`, `midnight`,
`near-midnight`, `ocean-floor`, `parchment`, `slate`, `stark`, and `sun-faded`.

Source-backed HTML can also carry a Notebook Kit theme attribute.

```html
<notebook theme="light-dark(cotton, slate)"> ... </notebook>
```
