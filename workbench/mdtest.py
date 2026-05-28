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
    nb = mo.ui.anywidget(
        obs.Notebook.from_observablehq(
            "https://observablehq.com/@esperanc/three-js-basics"
        )
    )
    nb
    return


if __name__ == "__main__":
    app.run()
