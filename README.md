<p align="center">
  <a href="https://peter-gy.github.io/pyobservablejs/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://peter-gy.github.io/pyobservablejs/img/brand/pyobservablejs-stacked-dark.svg">
      <img alt="pyobservablejs" src="https://peter-gy.github.io/pyobservablejs/img/brand/pyobservablejs-stacked-light.svg" width="320">
    </picture>
  </a>
</p>

<p align="center">
  <a href="https://github.com/peter-gy/pyobservablejs/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/peter-gy/pyobservablejs/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://pypi.org/project/pyobservablejs/"><img alt="PyPI" src="https://img.shields.io/pypi/v/pyobservablejs.svg"></a>
  <a href="https://pypi.org/project/pyobservablejs/"><img alt="Python versions" src="https://img.shields.io/pypi/pyversions/pyobservablejs.svg"></a>
  <a href="https://github.com/peter-gy/pyobservablejs/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/pypi/l/pyobservablejs.svg"></a>
</p>

`pyobservablejs` brings reactive [Observable notebooks](https://observablehq.com/notebook-kit/)
to Python. Build cells, charts, and browser inputs, or import an existing notebook.
Display the whole notebook or selected cells in JupyterLab, marimo, VS Code,
Colab, and other [anywidget](https://anywidget.dev/) hosts.

![An interactive notebook built from Python](https://files.peter.gy/projects/pyobservablejs/assets/from-code.gif)

[Try it in your browser](https://molab.marimo.io/github/peter-gy/pyobservablejs/blob/main/examples/from-code.py/wasm?utm_source=pyobservablejs)
· [Quickstart](https://peter-gy.github.io/pyobservablejs/guide/quickstart/)
· [Examples](https://peter-gy.github.io/pyobservablejs/examples/)
· [API reference](https://peter-gy.github.io/pyobservablejs/reference/)

## Start

Install in a Python 3.11 through 3.14 notebook environment:

```sh
pip install pyobservablejs
```

Create an input and a result that updates when it changes:

```python
import observablejs as obs

notebook = obs.Notebook(
    obs.ojs(
        "viewof threshold = Inputs.range([0, 1], {value: 0.5, step: 0.1})",
        key="control",
    ),
    obs.js(
        "const doubled = threshold * 2; display(md`Doubled: **${doubled}**`);",
        key="result",
    ),
)
view = notebook.view()
view
```

Cells run in the browser through [Notebook Kit](https://observablehq.com/notebook-kit/).
Its `Inputs` library loads from the network. Use notebook and module sources you
trust, since their JavaScript runs in the host page.

**Experimental:** the API may change between releases.

## Build on it

- **Compose views.** `notebook.view("result")` displays the result and evaluates
  its dependencies. [Select and arrange cells](https://peter-gy.github.io/pyobservablejs/guide/display/cells/).
- **Connect Python.** `notebook.update_variables({"threshold": 0.8})` updates
  mounted views. Read named results through `view.state`.
  [Send values and read results](https://peter-gy.github.io/pyobservablejs/guide/connect/).
- **Bring notebooks and data.** Load Notebook Kit HTML, public ObservableHQ
  notebooks, local files, and JavaScript modules.
  [Create and import notebooks](https://peter-gy.github.io/pyobservablejs/guide/create/).
- **Inspect and extract.** Browse cells, imports, attachments, and dependencies.
  Read datasets as Arrow or projected rows.
  [Inspect notebook data](https://peter-gy.github.io/pyobservablejs/guide/connect/inspect-notebooks/).
- **Work with agents.** The installed package carries instructions that match
  its API. [Read the packaged skill](https://peter-gy.github.io/pyobservablejs/guide/agents/)
  or the [documentation map](https://peter-gy.github.io/pyobservablejs/llms.txt).

[Documentation](https://peter-gy.github.io/pyobservablejs/)
· [Troubleshooting](https://peter-gy.github.io/pyobservablejs/guide/troubleshooting/)
· [Contributing](https://github.com/peter-gy/pyobservablejs/blob/main/development_docs/development.md)
· [MIT license](https://github.com/peter-gy/pyobservablejs/blob/main/LICENSE)

Built on Observable's [Notebook Kit](https://github.com/observablehq/notebook-kit)
and [anywidget](https://github.com/manzt/anywidget).
[`pyobsplot`](https://github.com/juba/pyobsplot) informed the Python variable API.
