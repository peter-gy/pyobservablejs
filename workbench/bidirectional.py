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
    # Bidirectional Observable state

    This workbench keeps one Observable notebook widget alive while Python
    controls update OJS variables and OJS controls sync values back to Python.
    """)
    return


@app.cell
def _(dt):
    letters_base = [
        {"letter": "A", "seen": dt.date(2026, 5, 21)},
        {"letter": "B", "seen": dt.date(2026, 5, 22)},
        {"letter": "C", "seen": dt.date(2026, 5, 23)},
        {"letter": "D", "seen": dt.date(2026, 5, 24)},
        {"letter": "E", "seen": dt.date(2026, 5, 25)},
    ]
    initial_frequencies = [0.0812, 0.0149, 0.0271, 0.0432, 0.1202]
    return initial_frequencies, letters_base


@app.cell
def _(initial_frequencies, letters_base, mo):
    frequency_sliders = [
        mo.ui.slider(
            start=0.01,
            stop=0.2,
            step=0.0001,
            value=frequency,
            label=f"Frequency of letter {letter['letter']}",
        )
        for letter, frequency in zip(letters_base, initial_frequencies)
    ]
    frequency_floor = mo.ui.slider(
        start=0.01,
        stop=0.16,
        step=0.005,
        value=0.04,
        label="Frequency floor",
    )
    python_gain = mo.ui.slider(
        start=0,
        stop=12,
        step=0.1,
        value=5,
        label="Python gain",
    )
    mo.vstack([*frequency_sliders, frequency_floor, python_gain])
    return frequency_floor, frequency_sliders, python_gain


@app.cell
def _(obs):
    notebook = obs.Notebook(
        obs.md("# One live Observable runtime", name="title"),
        obs.ojs(
            """
viewof gain = Inputs.range([0, 12], {
  value: 5,
  step: 0.1,
  label: "OJS gain"
})
""",
            name="gain",
        ),
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
`Python variables have ${letters.length} rows. Gain is ${gain.toFixed(1)}.`
""",
            name="data_readout",
        ),
        obs.ojs(
            """
letters
  .map((d) => `${d.letter}: ${d.seen.toISOString().slice(0, 10)}`)
  .join(", ")
""",
            name="dates",
        ),
        variables={"letters": [], "frequencyFloor": 0.04, "gain": 5},
    )
    return (notebook,)


@app.cell
def _(frequency_floor, frequency_sliders, letters_base, notebook, python_gain):
    letters = [
        {**letter, "frequency": slider.value}
        for letter, slider in zip(letters_base, frequency_sliders)
    ]
    notebook.update_variables(
        letters=letters,
        frequencyFloor=frequency_floor.value,
        gain=python_gain.value,
    )
    return (letters,)


@app.cell
def _(mo, notebook):
    notebook_view = mo.ui.anywidget(notebook)
    notebook_view
    return (notebook_view,)


@app.cell
def _(mo, notebook):
    child_ids = ", ".join(cell.model_id for cell in notebook.cells)
    mo.md(f"""
    **Notebook model id:** `{notebook.model_id}`

    **Cell model ids:** `{child_ids}`
    """)
    return


@app.cell
def _(mo, notebook):
    gain_cell_view = mo.ui.anywidget(notebook.cell("gain"))
    mo.vstack(
        [
            mo.md("**Gain cell widget**"),
            gain_cell_view,
        ]
    )
    return (gain_cell_view,)


@app.cell
def _(gain_cell_view, json, mo, notebook, notebook_view):
    gain_cell_view.value
    notebook_view.value
    gain_values = notebook.cell("gain").values
    all_values = notebook.values
    mo.md(f"""
    **Python sees OJS gain:** `{json.dumps(gain_values, sort_keys=True)}`

    **Notebook values:** `{json.dumps(all_values, sort_keys=True, default=str)}`
    """)
    return


@app.cell
def _(frequency_floor, letters, mo, python_gain):
    mo.md(f"""
    **Python variables pushed to OJS:** `{len(letters)}` rows,
    floor `{frequency_floor.value:.3f}`, gain `{python_gain.value:.1f}`
    """)
    return


if __name__ == "__main__":
    app.run()
