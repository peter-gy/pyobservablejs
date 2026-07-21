# Development

## Repository map

- `packages/pyobservablejs/` owns the public Python controller, private session
  model, renderable view model, serialization, tests, and packaged widget assets.
- `packages/runtime/` owns Notebook Kit analysis and execution.
- `packages/widget/` adapts notebook sessions and view-owned runtimes to
  anywidget rendering and synchronization.
- The npm and Python `anywidget-bundle` packages own the cross-language build
  and module-transport boundary consumed by the frontend build and Python
  widget models.
- `apps/docs/` owns the Docusaurus application, published MDX pages, and
  mdx-marimo integration.
- `development_docs/` contains contributor documentation that stays outside the
  published site.

Read [Architecture](architecture.md) before changing runtime ownership. See
[View composition](view-composition.md) before changing selections, shared
inputs, view readback, or teardown. See [Workspace](workspace.md) for package
commands and build ownership, and [Documentation build](docs-build.md) for the
Docusaurus workflow.

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

The build executes `python marimo` cells in the uv environments declared by
their `marimo-config` fences and writes the site to `apps/docs/build`. The
GitHub Pages workflow passes its configured deployment path through
`BASE_PATH`.

## Checks

Run the local gate before sending changes for review:

```sh
make check
```

## Releases

Put the next package version in a pull request:

```sh
uv version --package pyobservablejs --bump patch
```

Merge after the `required` and `docs` checks pass. From a clean, synchronized
`main` branch, inspect the release and push its annotated tag:

```sh
./scripts/release.sh --dry-run
./scripts/release.sh
```

The tag starts the Publish package workflow. That workflow checks the tag and
package versions, builds the wheel and sdist, publishes with PyPI Trusted
Publishing, creates the GitHub release notes, and installs the release from the
public PyPI index.

## Browser checks

For widget frontend, notebook rendering, Observable runtime, marimo or Jupyter
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

Run `example.ipynb` from a fresh kernel for Jupyter changes. Exercise the
mdx-marimo cells for documentation changes. When a change affects view
composition, mount the relevant full, focused, or composite views together and
exercise shared inputs, Python updates, and view-local readback. Inspect console
errors, the rendered DOM, and screenshots where they expose the behavior under
test.
