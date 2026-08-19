# /// script
# dependencies = [
#     "marimo",
#     "pyobservablejs",
# ]
# requires-python = ">=3.11,<3.15"
# ///

import marimo

__generated_with = "0.23.14"
app = marimo.App(width="medium")


@app.cell
def _():
    import marimo as mo
    import observablejs as obs

    return mo, obs


@app.cell(hide_code=True)
def _(mo, obs):
    notebook = obs.Notebook(
        obs.js(
            """
            const cylinders = view(Inputs.select(
              ["All", ...new Set(cars.map((d) => d.cylinders))],
              {label: "Cylinders", value: "All"}
            ));
            """,
            key="cylinder_control",
        ),
        obs.js(
            """
            const filteredCars = cylinders === "All"
              ? cars
              : cars.filter((d) => d.cylinders === cylinders);
            """,
            key="filtered_cars",
            display=False,
        ),
        obs.js("Inputs.table(filteredCars)", key="table"),
    )

    full_view = notebook.view()
    mo.output.replace(full_view)
    return (full_view,)


@app.cell(hide_code=True)
def _(full_view, mo):
    graph = full_view.state.graph
    graph is not None and mo.mermaid(graph.to_mermaid())


if __name__ == "__main__":
    app.run()
