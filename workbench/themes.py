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
    import marimo as mo
    import pyobservablejs as obs

    return mo, obs


@app.cell
def _(mo):
    mo.md(r"""
    # Notebook Kit themes

    Pick a bundled Notebook Kit theme. The dropdown updates the displayed
    Observable widget through `notebook.theme`.
    """)
    return


@app.cell
def _(mo, obs):
    selected_theme = mo.ui.dropdown(
        options=list(obs.NOTEBOOK_THEMES),
        value="air",
        label="Theme",
    )
    return (selected_theme,)


@app.cell
def _(mo, obs):
    notebook = obs.Notebook(
        obs.md("# Theme preview", name="title"),
        obs.html(
            """
<div style="
  background: var(--theme-background-alt);
  border: 1px solid var(--theme-foreground-fainter);
  color: var(--theme-foreground);
  font: 15px/1.45 var(--sans-serif);
  padding: 16px;
">
  <strong style="color: var(--theme-foreground-focus);">Notebook Kit theme card</strong>
  <div>Foreground, focus, border, and background tokens come from the selected theme.</div>
</div>
""",
            name="swatch",
        ),
        obs.ojs("md`Current theme: **${themeName}**`", name="theme_readout"),
        theme="air",
        variables={"themeName": "air"},
    )
    notebook_view = mo.ui.anywidget(notebook)
    return notebook, notebook_view


@app.cell
def _(notebook, selected_theme):
    applied_theme = selected_theme.value
    notebook.theme = applied_theme
    notebook.update_variables(themeName=applied_theme)
    return (applied_theme,)


@app.cell
def _(applied_theme, mo, notebook_view, selected_theme):
    mo.vstack(
        [
            selected_theme,
            notebook_view,
            mo.md(f"Active theme: `{applied_theme}`"),
        ]
    )
    return


if __name__ == "__main__":
    app.run()
