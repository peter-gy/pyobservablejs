# pyobservablejs

`pyobservablejs` is a browser-first Python interface to Observable Notebook Kit.
Python owns notebook construction, serialization, attachments, and controller
state. Browser TypeScript owns analysis, evaluation, rendering, browser input
synchronization, and view readback. Keep the public controller, private session
transport, and renderable view separate.

## Architecture

- `Notebook` is the public traitlets controller. It owns the prepared notebook
  definition, canonical cell handles, Python variables, attachment records,
  theme, lifecycle, and a detached `NotebookState` snapshot.
- `_NotebookSession` is the private anywidget model. It carries the definition,
  runtime profile, attachments, theme, options, Python variables, shared browser
  inputs, and cell keys to each view. Browser results stay on the view model.
- `NotebookView` is the public renderable anywidget. Each call to
  `Notebook.view()` creates one view model, DOM lifecycle, Notebook Kit runtime,
  and detached `ViewState`. Views from one notebook share session inputs while
  keeping evaluation and readback independent.
- `packages/runtime/` owns Notebook Kit analysis, dependency graphs, execution,
  attachments, runtime values, and the scoped browser environment. It has no
  anywidget model or Python packaging responsibilities.
- `packages/widget/` owns anywidget model resolution, view composition, DOM
  rendering, variable synchronization, readback, widget styles, and teardown.
  It depends on `@pyobservablejs/runtime` through `workspace:*`.
- `packages/pyobservablejs/` owns the public Python API,
  `observablejs.types` input mappings and state types, private traitlets models,
  final browser bundle, wheel, and sdist.
- The npm `anywidget-bundle` package owns the Vite plugin, browser module
  transport, manifest, and lifecycle protocol. The Python `anywidget-bundle`
  distribution owns the matching manifest and custom-message response APIs.
- `apps/docs/` owns the Docusaurus site and mdx-marimo integration.
  `development_docs/` owns contributor architecture, workspace, build, and
  runtime composition documentation.

Read [Architecture](development_docs/architecture.md) before changing runtime
ownership. Read [View composition](development_docs/view-composition.md) before
changing selection, synchronization, readback, or teardown. Use
[Workspace](development_docs/workspace.md) for the package graph and artifact
contracts and [Development](development_docs/development.md) for commands and
browser checks.

## Core invariants

- `NotebookCell.key` is public cell identity. `id` is Notebook Kit
  serialization metadata. `index` records notebook order. Public selection is
  key-based and accepts key strings, keyed authored `Cell` objects, or canonical
  handles from the same notebook.
- The `Notebook.state` and `NotebookView.state` traits publish detached,
  read-only snapshots and notify traitlets observers. Keep them as the public
  state access paths. Controller writes go through `update_variables`,
  `replace_variables`, `reset_variables`, or theme assignment.
- `_readback` is one complete wire snapshot with `revision`, `input_revision`,
  `settled_revision`, `pending`, `graph`, `results`, and `errors`. Browser
  transport revisions increase monotonically. Attempt tokens, input revisions,
  and observer generations reject stale callbacks. Python validates the full
  shape, accepts a strictly newer transport revision, and replaces
  `NotebookView.state` once.
- `_variables` carries Python-owned values. `_view_values` carries serializable
  named browser inputs across views. When Python takes ownership of a name,
  clear its browser value before applying the Python value. Variable patches
  update the live runtime. Variable replacement rebuilds the runtime so released
  names return to Notebook Kit evaluation.
- `NotebookModel` carries authored notebooks through `_spec` and source-backed
  notebooks through `_source`. Source HTML owns its theme and runtime profile.
  Preserve both across import and serialization. Send `pinned` as an explicit
  boolean for authored cells because Notebook Kit treats an omitted value as
  pinned.
- `packages/widget/src/styles/` owns widget CSS. `styles/widget.css` is the
  stylesheet entry point. `themes.ts` scopes Notebook Kit theme variables to
  `.pyobservablejs-notebook` and installs them in the owning document or shadow
  root. Keep widget selectors scoped to pyobservablejs root classes.

## Dependency rule

Cross-package TypeScript imports use package names. The widget may import the
runtime. The runtime must stay independent of the widget, anywidget, and Python
packaging. The private `@pyobservablejs/python` workspace package composes the
widget with npm `anywidget-bundle`. Keep the npm and PyPI `anywidget-bundle`
versions aligned.

Python and TypeScript communicate through the private session model and each
view's traits. Change both sides when a trait, serialized value, manifest, or
message shape crosses that boundary. Keep private session transport off the
public `Notebook` API.

## Tooling and generated files

The root `package.json` and `vite.config.ts` own JavaScript orchestration and
shared Vite+ policy. Package manifests own dependencies, tests, and builds. Use
the pnpm catalog for shared external versions.

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
- `apps/docs/.docusaurus/`
- `apps/docs/build/`

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
and package-boundary violations.

## Verification by boundary

- Test Python behavior through the public `observablejs` API. Test private
  session and view traits when the cross-language wire contract is the subject.
- Test TypeScript behavior through runtime, widget, Vite, DOM, and generated
  artifact contracts. Wait on observable state, not elapsed time.
- Validate Docusaurus MDX source with `make docs`. Serve the generated site with
  `make docs-serve` when browser inspection is required.
- Validate frontend, notebook, and docs behavior with `$agent-browser`. Exercise
  JupyterLab, mdx-marimo pages, and Python variable synchronization as relevant.
  Check console and page errors, then stop every browser session and local
  server.
- Build the wheel from the produced sdist when packaging changes. The sdist
  carries browser assets and must build outside the TypeScript workspace.

Published docs explain notebook authoring, frontend use, synchronized values,
and source imports. Keep package layout, release mechanics, generated artifacts,
and contributor workflows in `development_docs/`.

Comments should explain lifecycle ordering, invariants, cache behavior,
cross-runtime parity, generated-artifact constraints, or bailout reasons.
Delete comments that restate the code.
