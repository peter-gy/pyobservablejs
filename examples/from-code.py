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
    notebook = obs.Notebook(
        obs.md(
            """
            <h2>Palmer penguins</h2>
            <p>Choose a species to filter the chart.</p>
            """
        ),
        obs.ojs(
            """
            viewof species = Inputs.select(
              ["All", ...new Set(penguins.map((d) => d.species))],
              {label: "Species", value: "All"}
            )
            """,
        ),
        obs.js(
            """
            Plot.dot(
              species === "All"
                ? penguins
                : penguins.filter((d) => d.species === species),
              {
                x: "culmen_length_mm",
                y: "culmen_depth_mm",
                fill: "species",
                tip: true
              }
            ).plot({
              height: 320,
              color: {legend: true},
              x: {grid: true, label: "Bill length (mm)"},
              y: {grid: true, label: "Bill depth (mm)"}
            })
            """,
        ),
    )

    notebook.view()
    return


if __name__ == "__main__":
    app.run()
