# Development

## Repository map

- `packages/pyobservablejs/` owns the Python models, serialization, traitlets,
  tests, and packaged widget assets.
- `packages/runtime/` owns Notebook Kit analysis and execution.
- `packages/widget/` adapts notebook sessions and view-owned runtimes to
  anywidget rendering and synchronization.
- The npm and Python `anywidget-bundle` packages own the cross-language build
  and module-transport boundary consumed by the frontend build and Python
  widget models.
- `docs/` contains the published Jupyter Book source and live marimo pages.
- `development_docs/` contains contributor documentation that stays outside the
  published site.
- `make docs` builds the static documentation artifact.

Read [Architecture](architecture.md) before changing runtime ownership. See
[View composition](view-composition.md) before changing selections, shared
inputs, view readback, or teardown. See [Workspace](workspace.md) for package
commands and build ownership, and [Documentation build](docs-build.md) for the
Jupyter Book workflow.

## Setup

Install the Python and JavaScript dependencies:

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
make docs
```

Preview it locally:

```sh
make docs-serve
```

The build executes marimo pages in the uv environments declared by their
`{marimo-config}` blocks and writes the site to `docs/_build/html`. Set
`BASE_URL=/pyobservablejs` for a site published below that path.

## Checks

Run the full local gate before sending changes for review:

```sh
make check
```

## Browser checks

For widget frontend, notebook rendering, Observable runtime, Jupyter or marimo
integration, docs site rendering, or other user-visible changes, verify the
affected workflow in a browser.

Start JupyterLab in one shell:

```sh
uv run --package pyobservablejs jupyter lab --no-browser --port 27273 --ServerApp.token='' --ServerApp.password=''
```

Start the documentation server in another shell:

```sh
make docs-serve
```

Run `example.ipynb` from a fresh kernel for Jupyter changes. Exercise the live
marimo pages for documentation changes. When a change affects view composition,
mount the relevant full, focused, or composite views together and exercise
shared inputs, Python updates, and view-local readback. Inspect console errors,
the rendered DOM, and screenshots where they expose the behavior under test.
