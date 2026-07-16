---
title: Themes and pinned source
description: Apply Notebook Kit themes and show selected cell source.
---

# Themes and pinned source

`theme` accepts a Notebook Kit theme name or a light and dark mapping. Pinned
cells selected by the view appear in a source panel when
`show_pinned_source=True`.

The browser loads Plot and the AAPL sample used here. See [Notebook
runtime](notebook-runtime.md#builtins) for network and content security policy
requirements.

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
    obs.md("## AAPL closing price"),
    obs.js(
        """
        Plot.lineY(aapl, {x: "Date", y: "Close", tip: true}).plot({
          height: 260,
          y: {grid: true, label: "Close ($)"}
        })
        """,
        key="price_chart",
        pinned=True,
    ),
    theme={"light": "cotton", "dark": "slate"},
    show_pinned_source=True,
)

full_view = notebook.view()
mo.ui.anywidget(full_view)
```

The rendered view switches between `cotton` and `slate` with the browser color
scheme preference. It also exposes the chart source in its source panel.

## Theme names

Use a theme name exposed by `observablejs.NOTEBOOK_THEMES`.

```python
import observablejs as obs

obs.NOTEBOOK_THEMES
```

Source-backed HTML can also carry a Notebook Kit theme attribute.

```html
<notebook theme="light-dark(cotton, slate)">
	<script type="text/markdown">
		# Report
	</script>
</notebook>
```

See [Notebook themes](../reference/notebook-themes.md) for accepted names and
validation rules.
