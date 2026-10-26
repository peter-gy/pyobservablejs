# Development

## Repository map

- `packages/pyobservablejs/` owns the public Python controller, private session
  model, renderable view model, serialization, tests, and packaged widget assets.
- `packages/runtime/` owns source-to-DOM mounting, Notebook Kit analysis and
  execution, native values, styles, input controls, and evaluation state.
- `packages/widget/` adapts anywidget model references and Python wire values to
  runtime mounts and publishes serialized readback.
- `packages/protocol/` owns the Python wire codecs that the widget and engine share.
- `packages/engine/` owns the headless command service for the embedded V8
  isolate and the Chromium page.
- `crates/pyobservablejs-engine/` owns the Rust engine that embeds V8, and
  `crates/pyobservablejs-python/` exposes it to Python as `observablejs._engine`.
- The npm and Python `anywidget-bundle` packages own the cross-language build
  and module-transport boundary consumed by the frontend build and Python
  widget models.
- `apps/docs/` owns the Docusaurus application, published MDX pages, and
  mdx-marimo integration.
- `apps/e2e/` owns standalone TypeScript, marimo, JupyterLab, and Pyodide tests.
- `development_docs/` contains contributor documentation that stays outside the
  published site.

Read [Architecture](architecture.md) before changing runtime ownership. See
[View composition](view-composition.md) before changing selections, shared
inputs, view readback, or teardown. See [Workspace](workspace.md) for package
commands and build ownership, and [Documentation build](docs-build.md) for the
Docusaurus workflow. The [runtime README](../packages/runtime/README.md) documents
the standalone TypeScript API.

## Setup

Install [Pixi](https://pixi.prefix.dev/latest/installation/), which provides
Node, pnpm, uv, Rust, and Python from `pixi.lock`, and the platform C/C++
toolchain for linking: Xcode Command Line Tools on macOS, `build-essential` on
Linux, or Visual Studio Build Tools on Windows. Then install the workspace:

```sh
pixi run install
```

`install` installs the locked JavaScript packages, builds the widget and engine
assets, and compiles the native extension into `.venv`. The first build
downloads the verified V8 archive for your platform. Rerun it after engine or
Rust changes. `pixi task list` shows every task, and `pixi shell` opens a shell
with the same tools.

The `py311`, `py313`, and `py314` environments test other Python versions in
`.venv-py311`, `.venv-py313`, and `.venv-py314`:

```sh
pixi run -e py314 test-python
```

Start the Vite dev server for frontend work:

```sh
pixi run pnpm dev
```

In another shell, point the Python widget at that server:

```sh
OBSERVABLEJS_VITE_DEV_SERVER=http://127.0.0.1:5173 pixi run uv run --frozen jupyter lab
```

Use the local URL printed by Vite if it starts on another port.

## Documentation

Build the docs site:

```sh
pixi run docs
```

Preview it locally:

```sh
pixi run docs-serve
```

The build executes `python marimo` cells in the uv environments declared by
their `marimo-config` fences and writes the site to `apps/docs/build`. The
local preview runs at `http://127.0.0.1:27331/`. The GitHub Pages workflow
applies its deployment path to the published build.

## Checks

Run the local gate before sending changes for review:

```sh
pixi run check
```

`check` runs the JavaScript, Python, and Rust checks, every test suite, the
distribution builds, the Pyodide test, the docs build, and `actionlint`. Run one
part while iterating, such as `pixi run check-rust` or `pixi run test-python`.
`pixi run test-floors` installs the native wheel on Python 3.11 with each
runtime dependency at its declared lower bound.

Run [Knip](https://knip.dev/), the JavaScript and TypeScript unused-code checker,
on its own while resolving unused files, dependencies, exports, or types:

```sh
pixi run pnpm check:knip
```

`pnpm check` and the CI quality job run this check. `knip.jsonc` records
framework entry points and dependencies loaded through runtime strings.
Package entry exports remain available to external consumers. Internal
exports and types are checked for references across the workspace.

CI runs JavaScript checks and tests, Rust checks, tests Python 3.11 through
3.14, tests the runtime dependency floors, and builds every distribution. The
`test-js` job builds the widget and engine assets once. The `quality`,
`test-python`, `floors`, and `e2e` jobs download those assets from the same
workflow run. The `distributions` job calls `wheels.yml`, which builds and
verifies the native wheels, the pure wheel, and the sdist. The `e2e` job tests
the standalone runtime and live Python hosts in Chromium. The `required` check
passes when every CI job succeeds. The separate `docs` check builds the
documentation site.

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

The tag starts the Publish package workflow. It requires the tagged commit to
belong to `main` and its latest push CI run to have succeeded. It checks the tag
and package versions, builds the distributions through `wheels.yml`, and
publishes the five native wheels, the pure wheel, and the sdist with
[PyPI Trusted Publishing](https://docs.pypi.org/trusted-publishers/), which
authenticates the workflow through GitHub's identity token. After installing
and verifying the release from the public PyPI index, it creates the GitHub
release notes.

## Browser checks

For widget frontend, notebook rendering, Observable runtime, marimo or Jupyter
integration, docs site rendering, or other user-visible changes, verify the
affected workflow in a browser.

Start JupyterLab in one shell:

```sh
pixi run uv run --frozen jupyter lab --no-browser --port 27273 --ServerApp.token='' --ServerApp.password=''
```

Start the documentation server in another shell:

```sh
pixi run docs-serve
```

Run `example.ipynb` from a fresh kernel for Jupyter changes. Exercise the
mdx-marimo cells for documentation changes. When a change affects view
composition, mount the relevant full, focused, or composite views together and
exercise shared inputs, Python updates, and view-local readback. Inspect console
errors, the rendered DOM, and screenshots where they expose the behavior under
test.

## End-to-end tests

`apps/e2e` uses [Playwright](https://playwright.dev/), a browser test runner, to
exercise the standalone runtime and built widget. Its three servers host a
TypeScript consumer, marimo, and JupyterLab. Install Chromium once after
installing the workspace dependencies:

```sh
pixi run install-browser
```

Run the browser suite against the worktree package:

```sh
pixi run test-e2e
```

`test-e2e` installs the workspace before starting the test servers.
`pixi run check` runs the same suite. Tests wait for rendered controls,
native runtime state, and public Python readback. Each scenario starts in a
fresh browser context.
Playwright stops the servers when the run finishes.

Run a focused scenario with the assets already built:

```sh
pixi run pnpm --filter @pyobservablejs/e2e run test:e2e --grep "Python"
```

Exercise the runtime API directly during frontend work:

```sh
pixi run pnpm --filter @pyobservablejs/e2e exec vp dev --config standalone/vite.config.ts
```

The consumer runs at `http://127.0.0.1:27346/`. Its `scenario` query parameter
selects `inputs`, `shadow`, or `lifecycle`. The default scenario mounts HTML,
selects a cell with hidden dependencies, and reads native values. The consumer
imports `@pyobservablejs/runtime` directly. Stop the server before running
Playwright, which owns its test ports.

Failed runs retain screenshots and traces in `apps/e2e/test-results` and an
HTML report in `apps/e2e/playwright-report`. Open the report with:

```sh
pixi run pnpm --filter @pyobservablejs/e2e exec playwright show-report
```

The CI `e2e` job consumes the same widget asset artifact as Python tests and
packaging. It must pass for the `required` check to succeed. CI retains failed
browser reports for seven days.
