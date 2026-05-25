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
    import tempfile
    from pathlib import Path

    import marimo as mo
    import observablejs as ojs

    return Path, mo, ojs, tempfile


@app.cell
def _(mo):
    mo.md(r"""
    # Notebook construction methods

    The same widget can start from Python cells, Notebook Kit HTML, a local HTML
    file, or a public Observable notebook URL.
    """)
    return


@app.cell
def _():
    html_source = """<!doctype html>
<notebook>
  <title>Notebook Kit HTML</title>
  <script id="1" type="text/markdown">md`# Notebook Kit HTML`</script>
  <script id="2" type="application/vnd.observable.javascript" pinned>
Plot.plot({
  height: 220,
  y: {grid: true},
  marks: [Plot.barY([
    {letter: "A", frequency: 0.0812},
    {letter: "B", frequency: 0.0149},
    {letter: "C", frequency: 0.0271}
  ], {x: "letter", y: "frequency", tip: true})]
})
  </script>
</notebook>
"""
    return (html_source,)


@app.cell
def _(Path, html_source, tempfile):
    html_file = Path(tempfile.gettempdir()) / "observablejs-construction-methods.html"
    html_file.write_text(html_source, encoding="utf-8")
    return (html_file,)


@app.cell
def _():
    methods = [
        "Python cells",
        "HTML string",
        "HTML file",
        "Observable URL",
    ]
    return (methods,)


@app.cell
def _(methods, mo):
    method = mo.ui.dropdown(
        options=methods,
        value="Python cells",
        label="Method",
    )
    method
    return (method,)


@app.cell
def _(html_file, html_source, method, ojs):
    rows = [
        {"letter": "A", "frequency": 0.0812},
        {"letter": "B", "frequency": 0.0149},
        {"letter": "C", "frequency": 0.0271},
    ]
    selected_error = ""
    if method.value == "Python cells":
        selected_notebook = ojs.Notebook(
            ojs.md("# Python cells"),
            ojs.cell(
                """
Plot.plot({
  height: 220,
  y: {grid: true},
  marks: [Plot.barY(rows, {x: "letter", y: "frequency", tip: true})]
})
""",
                pinned=True,
            ),
            variables={"rows": rows},
            show_pinned_source=True,
        )
    elif method.value == "HTML string":
        selected_notebook = ojs.Notebook.from_html(
            html_source,
            show_pinned_source=True,
        )
    elif method.value == "HTML file":
        selected_notebook = ojs.Notebook.from_file(
            html_file,
            show_pinned_source=True,
        )
    else:
        try:
            selected_notebook = ojs.Notebook.from_url(
                "https://observablehq.com/@mbostock/saving-svg",
                show_pinned_source=True,
            )
        except Exception as exc:
            selected_notebook = None
            selected_error = str(exc)
    return selected_error, selected_notebook


@app.cell
def _(method, mo, selected_error, selected_notebook):
    _content = (
        mo.md(f"Unable to load {method.value}: `{selected_error}`")
        if selected_notebook is None
        else mo.ui.anywidget(selected_notebook)
    )
    _content
    return


@app.cell
def _(method, mo, selected_error, selected_notebook):
    _summary = (
        mo.md(f"**{method.value}** · load failed · `{selected_error}`")
        if selected_notebook is None
        else mo.md(
            f"""
            **{method.value}** · {len(selected_notebook.cells)} cells · {len(selected_notebook.attachments)} attachments
            """
        )
    )
    _summary
    return


if __name__ == "__main__":
    app.run()
