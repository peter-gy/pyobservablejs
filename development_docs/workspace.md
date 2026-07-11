# Workspace

The repository is both a pnpm workspace and a uv workspace. pnpm owns the
browser packages and final widget bundle. uv owns the publishable Python
distribution and contributor environment.

## Package graph

```text
@pyobservablejs/runtime
          |
          v
@pyobservablejs/widget       @pyobservablejs/anywidget-bundle
          |                              |
          +---------------+--------------+
                          v
                @pyobservablejs/python
                          |
                          v
                   PyPI pyobservablejs
```

| Package                     | Contract                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------ |
| `packages/runtime`          | Notebook Kit analysis, execution, attachments, variables, and browser runtime values |
| `packages/widget`           | anywidget model resolution, rendering, composition, synchronization, and teardown    |
| `packages/anywidget-bundle` | Vite plugin, manifest, module transport, and lifecycle protocol for a configured app |
| `packages/pyobservablejs`   | Python API, traitlets, final widget assets, wheel, and sdist                         |

Cross-package TypeScript imports use package names. Internal dependencies use
`workspace:*`. Shared external versions use the catalog in
`pnpm-workspace.yaml`.

## Toolchain

The root `vite.config.ts` configures Vite+ formatting, linting, type checks, and
task caching. Package-local Vite configs own tests and build behavior.

The root manifest leaves the Node module type unset. JupyterLab runs CommonJS
helper scripts from the repository-local Python environment, and Node resolves
their module type through ancestor manifests. Each TypeScript workspace package
declares its own ESM boundary.

The root `package.json` requires Node 22.18 or newer. CI selects the current
Node 22 release through `setup-vp`, matching the development engine contract
while receiving current security and runtime fixes.

Run the complete JavaScript workspace checks directly:

```sh
pnpm check
pnpm test
pnpm build
```

Use a package filter while iterating:

```sh
pnpm --filter @pyobservablejs/runtime test
pnpm --filter @pyobservablejs/widget build
pnpm --filter @pyobservablejs/anywidget-bundle test
pnpm --filter @pyobservablejs/python build
```

The root `pyproject.toml` defines a virtual uv workspace. The project metadata
and Hatch configuration live in `packages/pyobservablejs/pyproject.toml`.
The root `dev` group owns repository-wide tools and docs tooling: Ruff, ty,
pytest, Pyrefly, marimo, Jupyter, Jupyter Book, and its marimo plugin. The
package `dev` group owns Hatchling and watchfiles.
Scope commands to the distribution:

```sh
uv run --package pyobservablejs pytest -q packages/pyobservablejs/tests
pnpm --filter @pyobservablejs/python build
uv build --package pyobservablejs
uv version --package pyobservablejs --short
```

## Build artifacts

`vp pack` writes each TypeScript library to its package-local `dist/` directory.
The Python workspace package runs `vp build` and writes the deployable widget to
`packages/pyobservablejs/src/observablejs/static/`.

Hatch verifies the manifest, entry module, app module, and stylesheet before it
packages Python. The sdist contains the Python source, package metadata, and the
built browser assets. Building a wheel from that sdist uses the same assets and
works outside the pnpm workspace.

Run the full cross-language gate:

```sh
make check
```
