# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "marimo[recommended]>=0.23.8",
# ]
# ///

import marimo

__generated_with = "0.23.8"
app = marimo.App(width="full")


@app.cell
def _():
    import marimo as mo
    import observablejs as ojs

    return mo, ojs


@app.cell
def _(mo):
    mo.md(r"""
    # Public Observable URL loader

    This workbench keeps a small catalog of public Observable notebooks and
    fetches only the selected URL. Remote file attachments stay URL-backed.
    """)
    return


@app.cell
def _():
    urls = [
        "https://observablehq.com/@observablehq/plot-scatterplot/2",
        "https://observablehq.com/@observablehq/color-scatterplot",
        "https://observablehq.com/@observablehq/plot-diverging-color-scatterplot",
        "https://observablehq.com/@observablehq/plot-symbol-channel",
        "https://observablehq.com/@observablehq/scatterplot-with-interactive-tips",
        "https://observablehq.com/@observablehq/plot-proportional-symbol-scatterplot",
        "https://observablehq.com/@observablehq/plot-scatterplot-with-ordinal-dimension",
        "https://observablehq.com/@observablehq/plot-stacked-dots",
        "https://observablehq.com/@observablehq/qq-plot",
        "https://observablehq.com/@observablehq/plot-temperature-amplitude",
        "https://observablehq.com/@observablehq/plot-linear-regression-simpson",
        "https://observablehq.com/@observablehq/plot-dot-plot",
        "https://observablehq.com/@observablehq/plot-background-image",
        "https://observablehq.com/@observablehq/plot-ordinal-scatterplot",
        "https://observablehq.com/@observablehq/plot-dot-heatmap",
        "https://observablehq.com/@observablehq/plot-olympians-hexbin",
        "https://observablehq.com/@observablehq/plot-hexbin-binwidth",
        "https://observablehq.com/@fil/plot-voronoi-labels",
        "https://observablehq.com/@observablehq/plot-caltrain-schedule",
        "https://observablehq.com/@observablehq/plot-dodge-cars",
        "https://observablehq.com/@observablehq/plot-dodge-penguins",
        "https://observablehq.com/@observablehq/plot-barley-trellis",
        "https://observablehq.com/@observablehq/plot-two-dimensional-faceting",
        "https://observablehq.com/@observablehq/plot-non-faceted-marks",
        "https://observablehq.com/@observablehq/plot-dot-bins",
        "https://observablehq.com/@observablehq/plot-wealth-health-nations",
        "https://observablehq.com/@observablehq/plot-dot-sort",
        "https://observablehq.com/@observablehq/plot-us-bubble-map",
        "https://observablehq.com/@observablehq/plot-isotype-chart",
        "https://observablehq.com/@observablehq/plot-anscombes-quartet",
    ]
    return (urls,)


@app.cell
def _(mo, urls):
    selected_url = mo.ui.dropdown(
        options=urls,
        value=urls[0],
        label="Observable URL",
    )
    selected_url
    return (selected_url,)


@app.cell
def _(ojs, selected_url):
    try:
        selected_notebook = ojs.Notebook.from_url(
            selected_url.value,
            show_pinned_source=True,
        )
        selected_error = ""
    except Exception as exc:
        selected_notebook = None
        selected_error = str(exc)
    return selected_error, selected_notebook


@app.cell
def _(mo, selected_error, selected_notebook):
    _content = (
        mo.md(f"Selected notebook failed to load: `{selected_error}`")
        if selected_notebook is None
        else mo.ui.anywidget(selected_notebook)
    )
    _content
    return


@app.cell
def _(mo, selected_error, selected_notebook, selected_url, urls):
    _summary = (
        mo.md(f"**{selected_url.value}** · load failed · `{selected_error}`")
        if selected_notebook is None
        else mo.md(
            f"""
            **{selected_url.value}** · {len(selected_notebook.cells)} cells · {len(selected_notebook.attachments)} attachments · {len(urls)} URLs available
            """
        )
    )
    _summary
    return


@app.cell
def _(mo):
    mo.md(r"""
    ## Python variable override smoke

    This fixed example loads the Observable Plot scatterplot notebook and
    replaces its `penguins` variable with three Python rows.
    """)
    return


@app.cell
def _(mo):
    show_override_smoke = mo.ui.checkbox(
        label="Show Python variable override smoke",
        value=False,
    )
    show_override_smoke
    return (show_override_smoke,)


@app.cell
def _():
    override_url = "https://observablehq.com/@observablehq/plot-scatterplot/2"
    python_penguins = [
        {"culmen_length_mm": 36.7, "culmen_depth_mm": 18.4},
        {"culmen_length_mm": 44.1, "culmen_depth_mm": 15.9},
        {"culmen_length_mm": 50.2, "culmen_depth_mm": 19.1},
    ]
    return override_url, python_penguins


@app.cell
def _(ojs, override_url, python_penguins, show_override_smoke):
    if not show_override_smoke.value:
        override_notebook = None
        override_error = ""
    else:
        try:
            override_notebook = ojs.Notebook.from_url(
                override_url,
                variables={"penguins": python_penguins},
                show_pinned_source=True,
            )
            override_error = ""
        except Exception as exc:
            override_notebook = None
            override_error = str(exc)
    return override_error, override_notebook


@app.cell
def _(mo, override_error, override_notebook, show_override_smoke):
    _content = (
        mo.md("Enable the smoke check to fetch the fixed override notebook.")
        if not show_override_smoke.value
        else (
            mo.md(f"Override smoke notebook failed to load: `{override_error}`")
            if override_notebook is None
            else mo.ui.anywidget(override_notebook)
        )
    )
    _content
    return


@app.cell
def _(mo, override_error, override_notebook, override_url, show_override_smoke):
    _details = (
        mo.md("")
        if not show_override_smoke.value
        else (
            mo.md(f"**{override_url}** · load failed · `{override_error}`")
            if override_notebook is None
            else mo.md(
                f"""
                **{override_url}** · {len(override_notebook.cells)} cells · {len(override_notebook.attachments)} attachments · Python `penguins` override on
                """
            )
        )
    )
    _details
    return


if __name__ == "__main__":
    app.run()
