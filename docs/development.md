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
OBSERVABLEJS_VITE_DEV_SERVER=http://127.0.0.1:5173 uv run jupyter lab
```

Use the local URL printed by Vite if it starts on another port.

## Documentation

Build the docs site:

```sh
uv run python scripts/docs.py build
```

Preview it locally:

```sh
uv run python scripts/docs.py serve
```

Rendered docs pages use a fresh wheel from `dist/docs/`. The build copies that
wheel into `docs/_build/site/public/pkg/py/pyobservablejs/<sha256>/` and rewrites
generated metadata to the static path.

## Checks

Run the full local gate before sending changes for review:

```sh
pnpm format:check
pnpm lint
pnpm konsistent
pnpm typecheck
pnpm test:js
uv run ruff format --check .
uv run ruff check
uv run ty check
uv run pytest -q
pnpm build
uv run python scripts/docs.py build
git diff --check
```

## Browser checks

For widget frontend, notebook rendering, Observable runtime, Jupyter or marimo
integration, docs site rendering, or user-visible UI changes, run the local
frontends and verify them with `agent-browser`.

```sh
uv run jupyter lab --no-browser --port 27273 --ServerApp.token='' --ServerApp.password=''
uv run python scripts/docs.py serve
```

Verify:

- `example.ipynb` can restart and run all in JupyterLab, then renders the
  Observable title plus Plot output.
- docs pages with `{marimo}` blocks render their pyobservablejs widgets.
- `guides/python-variables` updates the Observable Plot when the Python slider
  changes without remounting the widget output.

Use `agent-browser console`, `agent-browser errors`, DOM or shadow-DOM
inspection, and screenshots where they expose the failure. Stop local servers and
browser sessions before handoff.
