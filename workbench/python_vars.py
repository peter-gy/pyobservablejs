# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "marimo[recommended]>=0.23.8",
# ]
# ///

import marimo

__generated_with = "0.23.8"
app = marimo.App(width="medium")


@app.cell
def _():
    import datetime as dt
    import json

    import marimo as mo
    import pyobservablejs as obs

    return dt, json, mo, obs


@app.cell
def _(mo):
    mo.md(r"""
    # Python variables in Observable

    Python `letters` and `frequencyFloor` feed OJS. Move the Gain control to
    sync its value back through `notebook.values`.
    """)
    return


@app.cell
def _(dt):
    letters = [
        {"letter": "A", "frequency": 0.0812, "seen": dt.date(2026, 5, 21)},
        {"letter": "B", "frequency": 0.0149, "seen": dt.date(2026, 5, 22)},
        {"letter": "C", "frequency": 0.0271, "seen": dt.date(2026, 5, 23)},
        {"letter": "D", "frequency": 0.0432, "seen": dt.date(2026, 5, 24)},
        {"letter": "E", "frequency": 0.1202, "seen": dt.date(2026, 5, 25)},
    ]
    frequency_floor = 0.04
    return frequency_floor, letters


@app.cell
def _(frequency_floor, letters, mo, obs):
    notebook = obs.Notebook(
        obs.md("# Python variables in Observable", name="title"),
        obs.ojs(
            """
    Plot.plot({
      height: 260,
      marginLeft: 48,
      y: {grid: true, label: "frequency"},
      color: {legend: true},
      marks: [
    Plot.ruleY([frequencyFloor]),
    Plot.barY(letters, {
      x: "letter",
      y: "frequency",
      fill: (d) => d.frequency >= frequencyFloor ? "above floor" : "below floor",
      tip: true
    })
      ]
    })
    """,
            name="chart",
        ),
        obs.ojs(
            """
    viewof gain = Inputs.range([0, 11], {value: 5, step: 0.1, label: "Gain"})
    """,
            name="gain",
        ),
        obs.ojs(
            """
    `Gain: ${gain.toFixed(1)}`
    """,
            name="gain_readout",
        ),
        obs.ojs(
            """
    letters
      .map((d) => `${d.letter}: ${d.seen.toISOString().slice(0, 10)}`)
      .join(", ")
    """,
            name="dates",
        ),
        variables={"letters": letters, "frequencyFloor": frequency_floor},
    )
    notebook_view = mo.ui.anywidget(notebook)
    notebook_view
    return notebook, notebook_view


@app.cell
def _(notebook, notebook_view):
    notebook_view.value
    notebook.values
    return


@app.cell
def _(json, mo, notebook, notebook_view):
    notebook_view.value
    values = notebook.values
    mo.md(
        f"notebook.values['gain'] = `{json.dumps(values.get('gain'), sort_keys=True)}`"
    )
    return


@app.cell
def _(frequency_floor, letters, mo):
    mo.md(f"""
    {len(letters)} Python records passed into OJS. Frequency floor = `{frequency_floor}`.
    """)
    return


if __name__ == "__main__":
    app.run()
