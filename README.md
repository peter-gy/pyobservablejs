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

> **Experimental:** `pyobservablejs` is experimental software. Its API may
> change between releases.

`pyobservablejs` embeds reactive Observable notebooks in Python. A notebook can
combine JavaScript, Observable JavaScript, Markdown, HTML, inputs, files, and
browser libraries, then render as an anywidget in JupyterLab, marimo, VS Code
notebooks, Google Colab, and other [anywidget](https://anywidget.dev/) hosts.

Python constructs the notebook and owns shared values. Notebook Kit runs each
view in the browser, where inputs rerun dependent cells and structured results
can return to Python.

![An authored notebook with an interactive filter and plot](https://files.peter.gy/projects/pyobservablejs/assets/from-code.gif)

[![Open in molab](https://molab.marimo.io/molab-shield.svg)](https://molab.marimo.io/github/peter-gy/pyobservablejs/blob/main/examples/from-code.py/wasm?utm_source=pyobservablejs)

## Install and render a notebook

Add `pyobservablejs` to a Python 3.11 through 3.14 environment:

```sh
uv pip install pyobservablejs
```

Or open a temporary marimo environment with the package available:

```sh
uvx --with pyobservablejs marimo edit notebook.py
```

Create a notebook with a heading, browser input, and reactive Markdown:

```python
import observablejs as obs

notebook = obs.Notebook(
    obs.md("## Threshold report"),
    obs.js(
        """
        const threshold = view(Inputs.range(
          [0, 1],
          {value: 0.5, step: 0.1, label: "Threshold"}
        ));
        """,
        key="threshold_control",
    ),
    obs.js(
        "md`Current threshold: **${threshold}**`",
        key="summary",
    ),
)

view = notebook.view()
view
```

The view renders the heading, slider, and current value. Moving the slider
reruns the summary in the browser. Each cell `key` is its public identity, so
`notebook.view("summary")` creates a focused view and evaluates its dependencies
with their output hidden.

Update the same input from Python while the view stays mounted:

```python
notebook.update_variables({"threshold": 0.8})
```

## Work with notebooks

| Task                                                               | Documentation                                                                                                                                                                                      |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Author JavaScript, Observable JavaScript, Markdown, and HTML cells | [Author notebook cells](https://peter-gy.github.io/pyobservablejs/guide/create/cells/)                                                                                                             |
| Load Notebook Kit HTML or a public ObservableHQ notebook           | [Create notebooks](https://peter-gy.github.io/pyobservablejs/guide/create/)                                                                                                                        |
| Display a whole notebook or selected keyed cells                   | [Display views](https://peter-gy.github.io/pyobservablejs/guide/display/)                                                                                                                          |
| Send Python values and read browser results                        | [Connect Python and Observable](https://peter-gy.github.io/pyobservablejs/guide/connect/)                                                                                                          |
| Register files or embed local JavaScript modules                   | [Add files and local modules](https://peter-gy.github.io/pyobservablejs/guide/create/files-and-modules/)                                                                                           |
| Inspect cell results, errors, and dependencies                     | [Read browser results](https://peter-gy.github.io/pyobservablejs/guide/connect/browser-results/) and [inspect dependencies](https://peter-gy.github.io/pyobservablejs/guide/connect/dependencies/) |

Views from one `Notebook` receive the same Python variables and supported
browser input values. Each view keeps its own browser runtime, rendered output,
results, errors, dependency graph, and lifecycle.

![Python and browser values updating one notebook](https://files.peter.gy/projects/pyobservablejs/assets/sync-variables.gif)

## Use with notebook agents

The `pyobservablejs` wheel carries an Agent Skill that matches its Python API.
Any Python process can use `observablejs.agent` to locate the packaged
instructions:

```python
import observablejs.agent as observablejs_agent

print(observablejs_agent.agent_skill() / "SKILL.md")
```

See [Use pyobservablejs with agents](https://peter-gy.github.io/pyobservablejs/guide/agents/)
for installed resources, LLM-readable documentation, and the optional marimo
code-mode path through marimo pair.

## Import a notebook

Notebook cells execute as JavaScript in the host page. Treat imported Notebook
Kit HTML, ObservableHQ notebooks, and remote modules as trusted code. See
[Browser execution and network access](https://peter-gy.github.io/pyobservablejs/guide/customize/browser-execution/).

[![Open in molab](https://molab.marimo.io/molab-shield.svg)](https://molab.marimo.io/github/peter-gy/pyobservablejs/blob/main/examples/from-observablehq.py/server?utm_source=pyobservablejs)

```python
import observablejs as obs

notebook = obs.Notebook.from_observablehq("@d3/world-tour")
notebook.view()
```

![An imported ObservableHQ notebook](https://files.peter.gy/projects/pyobservablejs/assets/from-slug.gif)

## Learn more

Start with the [quickstart](https://peter-gy.github.io/pyobservablejs/guide/quickstart/),
then use [complete examples](https://peter-gy.github.io/pyobservablejs/examples/),
[troubleshooting](https://peter-gy.github.io/pyobservablejs/guide/troubleshooting/),
or the [API reference](https://peter-gy.github.io/pyobservablejs/reference/) for
the next task.

## Acknowledgements

Thanks to the Observable team for [Notebook
Kit](https://github.com/observablehq/notebook-kit), which provides the notebook
format and runtime. [`pyobsplot`](https://github.com/juba/pyobsplot) informed
the Python variable API. [Trevor Manz](https://github.com/manzt)'s anywidget
composition demo shaped the shared-session design.

## License

MIT
