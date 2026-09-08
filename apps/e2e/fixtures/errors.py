import marimo

__generated_with = "0.24.0"
app = marimo.App()


@app.cell
def _():
    import marimo as mo
    import observablejs as obs

    return mo, obs


@app.cell
def _(obs):
    notebook = obs.Notebook(
        obs.ojs(
            """result = fail ? new Proxy({}, {
                ownKeys() { throw new TypeError("marimo inspection probe"); }
            }) : 42""",
            key="preview",
        ),
        variables={"fail": False},
    )
    view = notebook.view(capture_state=False)
    return notebook, view


@app.cell
def _(mo, notebook):
    trigger = mo.ui.button(
        label="Trigger inspection failure",
        on_click=lambda _: notebook.update_variables({"fail": True}),
    )
    recover = mo.ui.button(
        label="Recover inspection",
        on_click=lambda _: notebook.update_variables({"fail": False}),
    )
    mo.hstack([trigger, recover])


@app.cell
def _(mo, view):
    mo.vstack([view])


@app.cell
def _(mo, view):
    _ = view.value
    view.raise_for_errors()
    mo.md("Checkpoint healthy")


if __name__ == "__main__":
    app.run()
