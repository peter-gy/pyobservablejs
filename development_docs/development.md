# Development

## Repository map

- `packages/pyobservablejs/` owns the Python models, serialization, traitlets,
  tests, and packaged widget assets.
- `packages/runtime/` owns Notebook Kit analysis and execution.
- `packages/widget/` adapts the runtime to anywidget rendering and
  synchronization.
- `packages/anywidget-bundle/` and
  `packages/pyobservablejs/src/observablejs/_anywidget_bundle/` own the
  cross-language build and module-transport boundary.
- `docs/` contains the published Jupyter Book source and live marimo pages.
- `development_docs/` contains contributor documentation that stays outside the
  published site.
- `scripts/docs.py` builds the wheel and static documentation artifact.

Read [Architecture](architecture.md) before changing runtime ownership. See
[Workspace](workspace.md) for package commands and build ownership, and
[Documentation build](docs-build.md) for the wheel-backed docs workflow.

## Setup

Install Python and JavaScript dependencies:

```sh
uv sync --package pyobservablejs --group dev
pnpm install
```

Build the bundled widget assets:

```sh
pnpm --filter @pyobservablejs/python build
```

Start the Vite dev server for frontend work:

```sh
pnpm dev
```

In another shell, point the Python widget at that server:

```sh
OBSERVABLEJS_VITE_DEV_SERVER=http://127.0.0.1:5173 uv run --package pyobservablejs jupyter lab
```

Use the local URL printed by Vite if it starts on another port.

## Documentation

Build the docs site:

```sh
uv run --package pyobservablejs python scripts/docs.py build
```

Preview it locally:

```sh
uv run --package pyobservablejs python scripts/docs.py serve
```

Rendered docs pages use a fresh wheel from `dist/docs/`. The build copies that
wheel into `docs/_build/html/public/wheels/<sha256>/` and writes a base-aware,
same-origin path into the browser notebook metadata. Set
`BASE_URL=/pyobservablejs` for a site published below that path.

## Checks

Run the full local gate before sending changes for review:

```sh
make check
```

## Browser checks

For widget frontend, notebook rendering, Observable runtime, Jupyter or marimo
integration, docs site rendering, or user-visible UI changes, run the local
frontends and verify them with `agent-browser`.

Start JupyterLab in one shell:

```sh
uv run --package pyobservablejs jupyter lab --no-browser --port 27273 --ServerApp.token='' --ServerApp.password=''
```

Start the documentation server in another shell:

```sh
uv run --package pyobservablejs python scripts/docs.py serve
```

Verify:

- `example.ipynb` can restart and run all in JupyterLab, then renders the
  Observable title plus Plot output.
- docs pages with `{marimo}` blocks render their pyobservablejs widgets.
- `guides/python-variables` updates the Observable Plot when the Python slider
  changes without remounting the widget output.

Use `agent-browser console`, `agent-browser errors`, DOM or shadow-DOM
inspection, and screenshots where they expose the failure. Stop local servers
and browser sessions before handoff.
