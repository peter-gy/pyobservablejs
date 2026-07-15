# pyobservablejs

`pyobservablejs` is a browser-first Python interface to Observable Notebook Kit.
Python owns notebook models, serialization, attachments, and synchronized state.
The TypeScript frontend owns Notebook Kit evaluation and rendering. Preserve
that split.

## Workspace boundaries

- `packages/runtime/` owns Notebook Kit analysis and execution. It has no
  anywidget model or packaging concerns.
- `packages/widget/` adapts the runtime to anywidget rendering, model
  resolution, variable synchronization, and teardown. It depends on
  `@pyobservablejs/runtime` through `workspace:*`.
- `packages/anywidget-bundle/` owns the app-agnostic Vite plugin, browser module
  transport, manifest, and lifecycle protocol. It does not import the runtime
  or widget packages.
- `packages/pyobservablejs/` owns the public Python API and composes the widget
  with the bundle plugin into the static assets shipped in the wheel.
- `docs/` contains the published Jupyter Book. `development_docs/` contains
  contributor documentation outside the published site.

Use package names for cross-package imports. Do not import sibling source paths.
The Python distribution depends on `widget` and `anywidget-bundle`. `widget`
depends on `runtime`. `runtime` and `anywidget-bundle` remain independent.

Python and the frontend communicate through traitlets and anywidget mechanisms.
Change both sides when a trait, wire value, manifest, or message shape crosses
the boundary. Do not use notebook-host internals as a transport or lifecycle
escape hatch.

Read [Architecture](development_docs/architecture.md) before changing runtime
ownership. Use [Development](development_docs/development.md) for setup,
package commands, and browser checks. Use
[Workspace](development_docs/workspace.md) for the package graph and artifact
contracts.

## Tooling and generated files

The root `package.json` and `vite.config.ts` own JavaScript orchestration and
shared Vite+ policy. Package manifests own dependencies, tests, and builds. Use
`workspace:*` for internal dependencies and the pnpm catalog for shared external
versions.

The root `pyproject.toml` is a virtual uv workspace. The publishable project and
Hatch configuration live in `packages/pyobservablejs/pyproject.toml`. Scope uv
commands with `--package pyobservablejs`.

Prefer dependency-provided types. The parser and classic standard-library
packages do not publish types, so their declarations stay with the runtime
consumer in `packages/runtime/src/types/`.

These paths are generated:

- `packages/*/dist/`
- `packages/pyobservablejs/src/observablejs/static/`
- `dist/`
- `docs/_build/`
- `docs/.jupyter-book-marimo/`

Change source and rebuild. Do not hand-edit generated output.

## Mandatory handoff gate

Run the complete local gate before handing off a repository change:

```sh
make check
```

Vite+ owns JavaScript formatting, linting, type checks, tests, and package
builds. uv owns Python formatting, linting, type checks, tests, and packaging.
Fix underlying failures. Do not suppress checks. Inspect the final diff for
unrelated edits, stale generated files, listener cleanup, cross-language drift,
and accidental package-boundary violations.

## Verification by boundary

- Test Python behavior through the public `observablejs` API and serialized
  widget state.
- Test TypeScript behavior through runtime, widget, Vite, DOM, and generated
  artifact contracts. Wait on observable state, not elapsed time.
- Validate `scripts/docs.py` through a fresh wheel-backed build and a served
  interactive page.
- Validate frontend, notebook, and docs changes with `$agent-browser`. Exercise
  JupyterLab, the marimo-backed docs pages, and Python variable synchronization.
  Check console and page errors, then stop every browser session and local
  server.
- Build the wheel from the produced sdist when packaging changes. The sdist
  carries browser assets and must build without the sibling TypeScript
  workspaces.

Published docs explain notebook authoring, frontend use, runtime values, and
source imports. Keep package layout, release mechanics, generated artifacts,
and contributor workflows in `development_docs/`.

Comments should explain lifecycle ordering, invariants, cache behavior,
cross-runtime parity, generated-artifact constraints, or bailout reasons.
Delete comments that restate the code.
