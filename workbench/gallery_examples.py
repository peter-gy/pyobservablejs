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
    import os
    from pathlib import Path

    import marimo as mo
    import pyobservablejs as obs

    return Path, mo, obs, os


@app.cell
def _(mo):
    mo.md(r"""
    # Notebook Kit example gallery

    Load local Notebook Kit HTML examples from disk. An inline bar chart renders
    when the upstream gallery checkout is not present.
    """)
    return


@app.cell
def _():
    fallback_examples = {
        "inline/bar-chart.html": """<!doctype html>
    <notebook>
      <title>Inline bar chart</title>
      <script id="1" type="application/vnd.observable.javascript" pinned>
    Plot.plot({
      height: 260,
      y: {grid: true},
      marks: [
        Plot.barY([
          {letter: "A", frequency: 0.0812},
          {letter: "B", frequency: 0.0149},
          {letter: "C", frequency: 0.0271},
          {letter: "D", frequency: 0.0432},
          {letter: "E", frequency: 0.1202}
        ], {x: "letter", y: "frequency", tip: true})
      ]
    })
      </script>
    </notebook>
    """,
    }
    return (fallback_examples,)


@app.cell
def _(Path, fallback_examples, os):
    configured_root = os.environ.get("OBSERVABLEJS_GALLERY_ROOT") or os.environ.get(
        "NOTEBOOK_KIT_GALLERY_ROOT"
    )
    gallery_roots = []
    if configured_root:
        gallery_roots.append(Path(configured_root).expanduser())
    gallery_roots.append(
        Path.home() / "Projects/opensource/observablehq/notebook-kit/docs/ex"
    )

    gallery_root = None
    examples = []
    for root in gallery_roots:
        if root.exists():
            examples = sorted(root.rglob("*.html"))
            if examples:
                gallery_root = root
                break

    if gallery_root is None:
        example_sources = fallback_examples
        source_label = "inline fallback"
    else:
        example_sources = {
            str(path.relative_to(gallery_root)): path for path in examples
        }
        source_label = str(gallery_root)

    example_options = sorted(example_sources)
    default_example = (
        "d3/bar-chart.html"
        if "d3/bar-chart.html" in example_sources
        else example_options[0]
    )
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
    if isinstance(selected_source, Path):
        gallery_notebook = obs.Notebook.from_html(
            selected_source.read_text(encoding="utf-8"),
            base_path=selected_source.parent,
            show_pinned_source=True,
        )
    else:
        gallery_notebook = obs.Notebook.from_html(
            selected_source,
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
