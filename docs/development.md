---
title: Development
description: Local setup, docs, and checks for pyobservablejs contributors.
---

# Development

## Setup

Install Python and JavaScript dependencies:

```sh
uv sync --group dev
pnpm install
```

Build the bundled widget assets:

```sh
pnpm build
```

## Workbench

Use the workbench notebooks for manual exploration:

```sh
uv run marimo edit workbench/python_vars.py
uv run marimo edit workbench/gallery_examples.py
uv run marimo edit workbench/construction_methods.py
uv run marimo edit workbench/observable_urls.py
```

`workbench/gallery_examples.py` can load a local Observable Notebook Kit example
gallery. Set `NOTEBOOK_KIT_GALLERY_ROOT` to the `docs/ex` directory from a local
`observablehq/notebook-kit` checkout:

```sh
NOTEBOOK_KIT_GALLERY_ROOT=/Users/petergy/Projects/opensource/observablehq/notebook-kit/docs/ex uv run marimo edit workbench/gallery_examples.py
```

The notebooks cover separate runtime paths:

- `python_vars.py`: Python `variables` values, cell widgets, and value sync.
- `gallery_examples.py`: local Notebook Kit HTML examples.
- `construction_methods.py`: Python cells, HTML strings, HTML files, and public
  ObservableHQ notebooks.
- `observable_urls.py`: public ObservableHQ Plot loading, URL-backed
  attachments, and a fixed Python variable override example.

## Documentation

Build the docs site:

```sh
(cd docs && uv run jupyter book build --site)
```

Preview it locally:

```sh
(cd docs && uv run jupyter book start)
```

The docs use the Jupyter Book 2 / MyST project layout:

- `docs/myst.yml` contains project metadata and the table of contents.
- Markdown pages live directly under `docs/`.
- Generated files are written to `docs/_build/`.

## Checks

Run the full local gate before sending changes for review:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:js
uv run ruff format --check .
uv run ruff check
uv run ty check
uv run pytest -q
pnpm build
(cd docs && uv run jupyter book build --site)
git diff --check
```

## Browser Deep Checks

For widget frontend, notebook rendering, Observable runtime, Jupyter or marimo
integration, docs site rendering, or user-visible UI changes, run the local
frontends and verify them with `$agent-browser`.

```sh
uv run jupyter lab --no-browser --port 27273 --ServerApp.token='' --ServerApp.password=''
uv run marimo run --no-sandbox --headless --no-token --port 27271 workbench/python_vars.py
NOTEBOOK_KIT_GALLERY_ROOT=/Users/petergy/Projects/opensource/observablehq/notebook-kit/docs/ex \
  uv run marimo run --no-sandbox --headless --no-token --port 27272 workbench/gallery_examples.py
```

Verify:

- `example.ipynb` can restart and run all in JupyterLab, then renders the
  Observable title plus Plot output.
- `workbench/python_vars.py` renders without browser errors, and interactive OJS
  values propagate back to Python-visible `notebook.values`.
- `workbench/gallery_examples.py` renders the default gallery example and can
  switch to another example without console or page errors.

Use `agent-browser console`, `agent-browser errors`, DOM or shadow-DOM
inspection, and screenshots where they expose the failure. Stop local servers and
browser sessions before handoff.
