# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "marimo",
#     "pyobservablejs",
# ]
# ///

import marimo

__generated_with = "0.23.14"
app = marimo.App(width="medium")


@app.cell
def _():
    import marimo as mo
    import observablejs as obs

    return mo, obs


@app.cell
def _(mo, obs):
    notebook = obs.Notebook(
        obs.ojs(
            """
          viewof threshold = Inputs.range([0, 1], {
            value: 0.75,
            step: 0.05,
            label: "Threshold"
          })
          """
        ),
        obs.js("html`<p>Threshold: <strong>${threshold}</strong></p>`"),
        variables={"threshold": 0.75},
    )

    notebook_view = mo.ui.anywidget(notebook.view())
    notebook_view
    return notebook, notebook_view


@app.cell
def _(mo, notebook_view):
    mo.md(rf"""
    The `threshold` value from JS is ${notebook_view.values["threshold"] if notebook_view.has_rendered else "..."}$.
    """)
    return


@app.cell
def _(notebook):
    notebook.update_variables(threshold=0.9)
    return


if __name__ == "__main__":
    app.run()
