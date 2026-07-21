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
          """,
            key="threshold_control",
        ),
        obs.js(
            "html`<p>Threshold: <strong>${threshold}</strong></p>`",
            key="readout",
        ),
        variables={"threshold": 0.75},
    )

    notebook_view = mo.ui.anywidget(notebook.view())
    notebook_view
    return notebook, notebook_view


@app.cell
def _(mo, notebook_view):
    state = notebook_view.state
    threshold = "..."
    if (
        not state.pending
        and state.input_revision is not None
        and state.settled_revision == state.input_revision
    ):
        result = state.result("threshold_control")
        if result.status == "success":
            threshold = result.values["threshold"]
    mo.md(rf"""
    The `threshold` value from JS is ${threshold}$.
    """)
    return


@app.cell
def _(notebook):
    notebook.update_variables({"threshold": 0.9})
    return


if __name__ == "__main__":
    app.run()
