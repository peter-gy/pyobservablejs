import marimo

__generated_with = "0.23.8"
app = marimo.App(width="medium")


@app.cell
def _():
    import marimo as mo
    import pyobservablejs as obs

    return mo, obs


@app.cell
def _(mo, obs):
    notebook = obs.Notebook.from_observablehq(
        "https://observablehq.com/@observablehq/voronoi-spirals-ii"
    )
    notebook_view = mo.ui.anywidget(notebook)
    notebook_view
    return notebook, notebook_view


@app.cell
def _(mo, notebook, notebook_view):
    notebook_view.value
    mo.md(
        f"{len(notebook.cells)} cells available through `notebook.cells` after parent render."
    )
    return


if __name__ == "__main__":
    app.run()
