---
title: Examples
description: Rendered pyobservablejs examples for common notebook tasks.
---

# Examples

These examples use the public Python API and render in compatible anywidget
frontends. Each section shows Python source first, then renders the widget
produced by that source.

```{marimo-config}
:pyproject:

  requires-python = ">=3.10"
  dependencies = [
      "pyobservablejs @ https://files.peter.gy/pkg/py/pyobservablejs/pyobservablejs-0.0.0rc1-py3-none-any.whl#sha256=02b7ec0a297f81dd77f425a5e315eba537a71f93d9d58057ea0d004639cd44d8",
  ]
```

```python
import marimo as mo
import pyobservablejs as obs
```

```{marimo} python
:include: false

import marimo as mo
import pyobservablejs as obs
```

## Filter Python Records

Pass row dictionaries with `variables`. Observable `Inputs` can filter those
records and Plot can render the filtered result without another Python round
trip.

```python
incidents = [
    {"area": "auth", "open": 8, "severity": 2},
    {"area": "billing", "open": 5, "severity": 3},
    {"area": "search", "open": 11, "severity": 4},
    {"area": "exports", "open": 4, "severity": 1},
    {"area": "notebooks", "open": 7, "severity": 3},
]

incident_notebook = obs.Notebook(
    obs.md("# Open incidents"),
    obs.ojs(
        'viewof minimumSeverity = Inputs.range([1, 4], '
        '{value: 2, step: 1, label: "minimum severity"})',
        name="minimumSeverity",
    ),
    obs.ojs(
        """
        filteredIncidents = incidents.filter(
          (d) => d.severity >= minimumSeverity
        )
        """,
        name="filteredIncidents",
        display=False,
    ),
    obs.ojs(
        """
        Plot.plot({
          height: 230,
          marginLeft: 72,
          x: {grid: true, label: "open incidents"},
          y: {label: null},
          color: {legend: true},
          marks: [
            Plot.barX(filteredIncidents, {
              x: "open",
              y: "area",
              fill: "severity",
              tip: true
            }),
            Plot.ruleX([0])
          ]
        })
        """,
        name="chart",
    ),
    variables={"incidents": incidents},
)

mo.ui.anywidget(incident_notebook)
```

```{marimo} python
:include: false

incidents = [
    {"area": "auth", "open": 8, "severity": 2},
    {"area": "billing", "open": 5, "severity": 3},
    {"area": "search", "open": 11, "severity": 4},
    {"area": "exports", "open": 4, "severity": 1},
    {"area": "notebooks", "open": 7, "severity": 3},
]
```

```{marimo} python
:include: false

incident_notebook = obs.Notebook(
    obs.md("# Open incidents"),
    obs.ojs(
        'viewof minimumSeverity = Inputs.range([1, 4], '
        '{value: 2, step: 1, label: "minimum severity"})',
        name="minimumSeverity",
    ),
    obs.ojs(
        """
        filteredIncidents = incidents.filter(
          (d) => d.severity >= minimumSeverity
        )
        """,
        name="filteredIncidents",
        display=False,
    ),
    obs.ojs(
        """
        Plot.plot({
          height: 230,
          marginLeft: 72,
          x: {grid: true, label: "open incidents"},
          y: {label: null},
          color: {legend: true},
          marks: [
            Plot.barX(filteredIncidents, {
              x: "open",
              y: "area",
              fill: "severity",
              tip: true
            }),
            Plot.ruleX([0])
          ]
        })
        """,
        name="chart",
    ),
    variables={"incidents": incidents},
)
```

```{marimo} python
mo.ui.anywidget(incident_notebook)
```

Move the severity control. The browser updates the `filteredIncidents` cell and
redraws the chart inside the same Observable runtime.

## Load Notebook Kit HTML

Use `from_html` when a Notebook Kit source string already exists. Python can
still override source variables through `variables`.

```python
sessions = [
    {"day": "Mon", "segment": "self-serve", "sessions": 330},
    {"day": "Tue", "segment": "self-serve", "sessions": 372},
    {"day": "Wed", "segment": "self-serve", "sessions": 358},
    {"day": "Thu", "segment": "self-serve", "sessions": 391},
    {"day": "Mon", "segment": "enterprise", "sessions": 118},
    {"day": "Tue", "segment": "enterprise", "sessions": 133},
    {"day": "Wed", "segment": "enterprise", "sessions": 147},
    {"day": "Thu", "segment": "enterprise", "sessions": 142},
]

session_source = """
<!doctype html>
<notebook theme="glacier">
  <script
    id="1"
    name="segment"
    type="application/vnd.observable.javascript"
  >viewof segment = Inputs.select(
  ["all", "self-serve", "enterprise"],
  {value: "all", label: "segment"}
)</script>
  <script
    id="2"
    name="visibleSessions"
    hidden
    type="application/vnd.observable.javascript"
  >visibleSessions = segment === "all"
  ? sessions
  : sessions.filter((d) => d.segment === segment)</script>
  <script
    id="3"
    name="sessionChart"
    type="application/vnd.observable.javascript"
  >Plot.plot({
  height: 230,
  marginLeft: 48,
  y: {grid: true, label: "sessions"},
  color: {legend: true},
  marks: [
    Plot.barY(visibleSessions, {
      x: "day",
      y: "sessions",
      fill: "segment",
      tip: true
    })
  ]
})</script>
</notebook>
"""

session_notebook = obs.Notebook.from_html(
    session_source,
    variables={"sessions": sessions},
)

mo.ui.anywidget(session_notebook)
```

```{marimo} python
:include: false

sessions = [
    {"day": "Mon", "segment": "self-serve", "sessions": 330},
    {"day": "Tue", "segment": "self-serve", "sessions": 372},
    {"day": "Wed", "segment": "self-serve", "sessions": 358},
    {"day": "Thu", "segment": "self-serve", "sessions": 391},
    {"day": "Mon", "segment": "enterprise", "sessions": 118},
    {"day": "Tue", "segment": "enterprise", "sessions": 133},
    {"day": "Wed", "segment": "enterprise", "sessions": 147},
    {"day": "Thu", "segment": "enterprise", "sessions": 142},
]
```

```{marimo} python
:include: false

session_source = """
<!doctype html>
<notebook theme="glacier">
  <script
    id="1"
    name="segment"
    type="application/vnd.observable.javascript"
  >viewof segment = Inputs.select(
  ["all", "self-serve", "enterprise"],
  {value: "all", label: "segment"}
)</script>
  <script
    id="2"
    name="visibleSessions"
    hidden
    type="application/vnd.observable.javascript"
  >visibleSessions = segment === "all"
  ? sessions
  : sessions.filter((d) => d.segment === segment)</script>
  <script
    id="3"
    name="sessionChart"
    type="application/vnd.observable.javascript"
  >Plot.plot({
  height: 230,
  marginLeft: 48,
  y: {grid: true, label: "sessions"},
  color: {legend: true},
  marks: [
    Plot.barY(visibleSessions, {
      x: "day",
      y: "sessions",
      fill: "segment",
      tip: true
    })
  ]
})</script>
</notebook>
"""
```

```{marimo} python
:include: false

session_notebook = obs.Notebook.from_html(
    session_source,
    variables={"sessions": sessions},
)
```

```{marimo} python
mo.ui.anywidget(session_notebook)
```

The source owns the cells. Python owns the `sessions` variable supplied to the
rendered runtime.

## Apply a Notebook Kit Theme

`theme` accepts any name from `obs.NOTEBOOK_THEMES` or a mapping with `light` and
`dark` theme names. The widget scopes Notebook Kit theme CSS to the rendered
notebook root.

```python
theme_notebook = obs.Notebook(
    obs.md("# Theme preview"),
    obs.html(
        """
        <div style="
          background: var(--theme-background-alt);
          border: 1px solid var(--theme-foreground-fainter);
          color: var(--theme-foreground);
          font: 15px/1.45 var(--sans-serif);
          padding: 16px;
        ">
          <strong style="color: var(--theme-foreground-focus);">
            Scoped Notebook Kit tokens
          </strong>
          <div>
            This card reads theme CSS variables inside the widget.
          </div>
        </div>
        """,
        name="swatch",
    ),
    obs.ojs(
        'viewof panel = Inputs.radio(["summary", "detail"], '
        '{value: "summary", label: "panel"})',
        name="panel",
    ),
    obs.ojs(
        """
        panel === "summary"
          ? md`Theme: **${themeName}**`
          : md`Available themes: **${themeCount}**`
        """,
        name="theme_readout",
    ),
    variables={
        "themeName": "light-dark(cotton, slate)",
        "themeCount": len(obs.NOTEBOOK_THEMES),
    },
    theme={"light": "cotton", "dark": "slate"},
)

mo.ui.anywidget(theme_notebook)
```

```{marimo} python
:include: false

theme_notebook = obs.Notebook(
    obs.md("# Theme preview"),
    obs.html(
        """
        <div style="
          background: var(--theme-background-alt);
          border: 1px solid var(--theme-foreground-fainter);
          color: var(--theme-foreground);
          font: 15px/1.45 var(--sans-serif);
          padding: 16px;
        ">
          <strong style="color: var(--theme-foreground-focus);">
            Scoped Notebook Kit tokens
          </strong>
          <div>
            This card reads theme CSS variables inside the widget.
          </div>
        </div>
        """,
        name="swatch",
    ),
    obs.ojs(
        'viewof panel = Inputs.radio(["summary", "detail"], '
        '{value: "summary", label: "panel"})',
        name="panel",
    ),
    obs.ojs(
        """
        panel === "summary"
          ? md`Theme: **${themeName}**`
          : md`Available themes: **${themeCount}**`
        """,
        name="theme_readout",
    ),
    variables={
        "themeName": "light-dark(cotton, slate)",
        "themeCount": len(obs.NOTEBOOK_THEMES),
    },
    theme={"light": "cotton", "dark": "slate"},
)
```

```{marimo} python
mo.ui.anywidget(theme_notebook)
```

The browser receives the normalized theme trait and applies the matching
Notebook Kit CSS under this widget. Other widgets on the page keep their own
theme roots.

## Load a Public ObservableHQ Notebook

Use `from_observablehq` with a full ObservableHQ URL, notebook slug, or document
id.

```python
notebook = obs.Notebook.from_observablehq(
    "https://observablehq.com/@mbostock/saving-svg",
)
notebook
```

Pass `variables` to replace named variables from the loaded notebook with Python
values.

Public notebooks are fetched from ObservableHQ's document API. Uploaded files
stay as remote attachment URLs unless you override them with `attachments`.
