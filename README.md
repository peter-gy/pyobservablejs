# pyobservablejs

[![CI](https://github.com/peter-gy/pyobservablejs/actions/workflows/ci.yml/badge.svg)](https://github.com/peter-gy/pyobservablejs/actions/workflows/ci.yml)
[![PyPI](https://img.shields.io/pypi/v/pyobservablejs.svg)](https://pypi.org/project/pyobservablejs/)
[![Python versions](https://img.shields.io/pypi/pyversions/pyobservablejs.svg)](https://pypi.org/project/pyobservablejs/)
[![License](https://img.shields.io/pypi/l/pyobservablejs.svg)](https://github.com/peter-gy/pyobservablejs/blob/main/LICENSE)

> **Experimental:** `pyobservablejs` is experimental software. Its API is
> subject to breaking changes.

`pyobservablejs` embeds reactive Observable notebooks in Python. Author cells or
load an existing notebook, render all or selected cells, synchronize Python
values, read structured browser results, and inspect the dependency graph.

![An authored notebook with an interactive filter and plot](https://files.peter.gy/projects/pyobservablejs/assets/from-code.gif)

It works in JupyterLab, marimo, VS Code notebooks, Google Colab, and other
environments that support [anywidget](https://anywidget.dev/).

## Install

Add `pyobservablejs` to an existing Python 3.11 or newer environment:

```sh
uv pip install pyobservablejs
```

Or open a disposable marimo environment with the package available:

```sh
uvx --with pyobservablejs marimo edit notebook.py
```

This command installs marimo and `pyobservablejs` in the temporary environment.

## Quickstart

Paste this into the marimo editor opened above:

[![Open in molab](https://molab.marimo.io/molab-shield.svg)](https://molab.marimo.io/github/peter-gy/pyobservablejs/blob/main/examples/from-code.py/wasm?utm_source=pyobservablejs)

```python
import observablejs as obs

control = obs.ojs(
    """
    viewof threshold = Inputs.range([0, 1], {
      value: 0.5,
      step: 0.1,
      label: "Threshold"
    })
    """,
    key="threshold",
)

result = obs.js(
    "html`<strong>Threshold: ${threshold}</strong>`",
    key="result",
)

notebook = obs.Notebook(
    control,
    result,
    variables={"threshold": 0.5},
)

notebook.view()
```

Each cell `key` is its portable Python identity. Render one result with
`notebook.view("result")`.

## Capabilities

| Task                                                               | API                                                |
| ------------------------------------------------------------------ | -------------------------------------------------- |
| Author JavaScript, Observable JavaScript, Markdown, and HTML cells | `obs.js`, `obs.ojs`, `obs.md`, `obs.html`          |
| Load Notebook Kit HTML or an ObservableHQ notebook                 | `Notebook.from_html`, `Notebook.from_observablehq` |
| Render a whole notebook or selected keyed cells                    | `notebook.view()` and `notebook.view("chart")`     |
| Update Python-owned variables                                      | `notebook.update_variables({"threshold": 0.8})`    |
| Read pending, successful, and failed browser results               | `view.state` and `view.state.result("chart")`      |
| Inspect dependencies or export a diagram                           | `view.state.graph`, `to_mermaid()`, and `to_d2()`  |

Views from one `Notebook` share controller variables and supported browser
inputs. Each view keeps its own result state plus input and settled revision
metadata.

Use `notebook.view(capture_state=False)` when the rendered output is all you
need and Python will not read `view.state`. The view remains interactive and
avoids sending result snapshots to Python. See [Display
views](https://peter-gy.github.io/pyobservablejs/render/display-views/#skip-python-state-capture).

![Python and browser values updating one notebook](https://files.peter.gy/projects/pyobservablejs/assets/sync-variables.gif)

### Import notebooks

Notebook cells execute as JavaScript in the host page. Treat imported Notebook
Kit HTML, ObservableHQ notebooks, and remote modules as trusted code. See
[Browser execution](https://peter-gy.github.io/pyobservablejs/customize/browser-execution/).

[![Open in molab](https://molab.marimo.io/molab-shield.svg)](https://molab.marimo.io/github/peter-gy/pyobservablejs/blob/main/examples/from-observablehq.py/server?utm_source=pyobservablejs)

```python
import observablejs as obs

notebook = obs.Notebook.from_observablehq("@d3/world-tour")
notebook.view()
```

![An imported ObservableHQ notebook](https://files.peter.gy/projects/pyobservablejs/assets/from-slug.gif)

## Documentation

Read the [documentation](https://peter-gy.github.io/pyobservablejs/) for the
quickstart, task guides, recipes, troubleshooting, and API reference.

## Acknowledgements

Thanks to the Observable team for [Notebook
Kit](https://github.com/observablehq/notebook-kit), which provides the notebook
format and runtime. [`pyobsplot`](https://github.com/juba/pyobsplot) informed
the Python variable API. [Trevor Manz](https://github.com/manzt)'s anywidget
composition demo shaped the shared-session design.

## License

MIT
