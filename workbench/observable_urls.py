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

    This workbench loads public Observable notebooks through the document API,
    keeps remote file attachments as URL-backed attachments, and renders one
    selected notebook.
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
def _(ojs, urls):
    notebooks = {}
    rows = []
    for url in urls:
        try:
            _notebook = ojs.Notebook.from_url(url)
            notebooks[url] = _notebook
            rows.append(
                {
                    "status": "ok",
                    "url": url,
                    "cells": len(_notebook.cells),
                    "attachments": len(_notebook.attachments),
                }
            )
        except Exception as exc:
            notebooks[url] = None
            rows.append(
                {
                    "status": "error",
                    "url": url,
                    "cells": 0,
                    "attachments": 0,
                    "error": str(exc),
                }
            )
    return notebooks, rows


@app.cell
def _(mo, rows, urls):
    ok_count = sum(1 for row in rows if row["status"] == "ok")
    mo.md(f"**{ok_count} / {len(urls)}** public Observable notebooks loaded.")
    return


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
def _(mo, rows):
    mo.ui.table(rows)
    return


@app.cell
def _(mo, notebooks, selected_url):
    _notebook = notebooks[selected_url.value]
    _content = (
        mo.md("Selected notebook failed to load.")
        if _notebook is None
        else mo.ui.anywidget(_notebook)
    )
    _content
    return


@app.cell
def _(mo, notebooks, selected_url):
    _notebook = notebooks[selected_url.value]
    _summary = (
        mo.md("No notebook metadata available.")
        if _notebook is None
        else mo.md(
            f"""
            **{selected_url.value}** · {len(_notebook.cells)} cells · {len(_notebook.attachments)} attachments
            """
        )
    )
    _summary
    return


if __name__ == "__main__":
    app.run()
