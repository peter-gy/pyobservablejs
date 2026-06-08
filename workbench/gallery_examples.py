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
    from pathlib import Path

    import marimo as mo
    import pyobservablejs as obs

    return Path, mo, obs


@app.cell
def _(mo):
    mo.md(r"""
    # Notebook Kit example gallery

    Load the repo-local Notebook Kit HTML examples from disk. Each example goes
    through `obs.Notebook.from_html`.
    """)
    return


@app.cell
def _(Path):
    gallery_root = Path(__file__).with_name("notebook_kit_gallery")
    examples = sorted(gallery_root.rglob("*.html"))
    if not examples:
        raise RuntimeError(f"No Notebook Kit examples found in {gallery_root}")

    example_sources = {str(path.relative_to(gallery_root)): path for path in examples}
    example_options = sorted(example_sources)
    default_example = (
        "bar-chart.html" if "bar-chart.html" in example_sources else example_options[0]
    )
    source_label = "workbench/notebook_kit_gallery"
    return default_example, example_options, example_sources, source_label


@app.cell
def _(default_example, example_options, mo):
    selected_example = mo.ui.dropdown(
        options=example_options,
        value=default_example,
        label="Example",
    )
    selected_example
    return (selected_example,)


@app.cell
def _(Path, example_sources, mo, obs, selected_example):
    selected_source = example_sources[selected_example.value]
    gallery_notebook = obs.Notebook.from_html(
        selected_source.read_text(encoding="utf-8"),
        base_path=selected_source.parent,
        show_pinned_source=True,
    )
    gallery_notebook_view = mo.ui.anywidget(gallery_notebook)
    gallery_notebook_view
    return gallery_notebook, gallery_notebook_view


@app.cell
def _(example_options, gallery_notebook, mo, selected_example, source_label):
    mo.md(f"""
    **{selected_example.value}** · {len(gallery_notebook.attachments)} embedded file attachments · {len(example_options)} examples available · `{source_label}`
    """)
    return


@app.cell
def _(gallery_notebook, mo):
    mo.md(
        f"{len(gallery_notebook.cells)} cells available through `gallery_notebook.cells`."
    )
    return


if __name__ == "__main__":
    app.run()
