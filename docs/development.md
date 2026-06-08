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

Start the Vite dev server for frontend work:

```sh
pnpm dev
```

In another shell, point the Python widget at that server:

```sh
PYOBSERVABLEJS_VITE_DEV_SERVER=http://127.0.0.1:5173 uv run jupyter lab
```

Use the local URL printed by Vite if it starts on another port.
When `PYOBSERVABLEJS_VITE_DEV_SERVER` is set, `_esm` loads
`js/widget/dev.ts?anywidget` from Vite and Vite injects the widget CSS.
`pnpm build` still writes the production assets under `src/pyobservablejs/static`.
Frontends that only trust local anywidget files should use the production build
path.

The chunked anywidget machinery is split from the Observable renderer:

- `src/pyobservablejs/_chunked_anywidget.py` serves built JavaScript chunks
  through anywidget traitlets and commands.
- `js/anywidget/chunked-module-loader.ts` loads those chunks in the browser.
- `js/anywidget/vite-config.ts` defines the reusable Vite library build.
- `js/notebook/` owns Notebook Kit graph metadata.
- `js/runtime/` owns Observable Runtime wiring and value serialization.
- `js/widget/` owns anywidget entries, DOM rendering, child composition, model
  traits, and browser-to-Python sync.

## Workbench

Use the workbench notebooks for manual exploration:

```sh
uv run marimo edit workbench/python_vars.py
uv run marimo edit workbench/gallery_examples.py
uv run marimo edit workbench/construction_methods.py
uv run marimo edit workbench/observable_urls.py
```

`workbench/gallery_examples.py` loads the repo-local Notebook Kit HTML examples
under `workbench/notebook_kit_gallery`.

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
