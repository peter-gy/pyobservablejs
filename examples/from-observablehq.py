# /// script
# dependencies = [
#     "marimo",
#     "pyobservablejs",
# ]
# requires-python = ">=3.11"
# ///

import marimo

__generated_with = "0.23.14"
app = marimo.App(width="medium")


@app.cell(hide_code=True)
def _():
    import observablejs as obs

    return (obs,)


@app.cell(hide_code=True)
def _(obs):
    notebook = obs.Notebook.from_observablehq("@d3/world-tour")
    notebook.view()


if __name__ == "__main__":
    app.run()
