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
    notebook = obs.Notebook.from_observablehq("@d3/world-tour")
    mo.ui.anywidget(notebook.view())
    return


if __name__ == "__main__":
    app.run()
