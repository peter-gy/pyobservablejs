# pyobservablejs

`pyobservablejs` is a browser-first Python interface to Observable Notebook Kit.
Python owns notebook models, serialization, attachments, and synchronized state.
The TypeScript frontend owns Notebook Kit evaluation and rendering. Preserve
that split. Favor lifecycle correctness, portable artifacts, and stable user
contracts over shortcuts at either runtime boundary.

The distribution is named `pyobservablejs`. Python imports it as `observablejs`.

## Architecture boundaries

- `src/observablejs/` owns the public Python API, traitlets, serialization, and
  browser readback.
- `js/runtime/` owns Notebook Kit analysis and execution. Keep it independent of
  anywidget model details.
- `js/widget/` adapts the runtime to anywidget model resolution, rendering,
  variable synchronization, and teardown.
- `js/anywidget-bundle/` and `src/observablejs/_anywidget_bundle/` form the
  private build and module-transport boundary. Keep manifest rules, path
  validation, protocol envelopes, and lifecycle behavior aligned across both
  languages.
- `docs/` contains the published Jupyter Book. `scripts/docs.py` builds a fresh
  wheel, executes interactive pages, and publishes that wheel with the static
  site.
- `development_docs/` contains plain Markdown for contributors and coding
  agents. It is outside the published documentation build.

Python and the frontend communicate through traitlets and anywidget mechanisms.
Do not use marimo internals as a transport or lifecycle escape hatch. Change
TypeScript and Python contracts together when a trait, wire value, manifest, or
message shape crosses the boundary.

Read [Architecture](development_docs/architecture.md) before changing runtime
ownership. Use [Development](development_docs/development.md) for setup, focused
workflows, and browser checks.

## Source and generated files

Use `pnpm` and `uv` for dependency and lockfile changes. Prefer package-provided
types. Keep unavoidable local declarations under `js/types/`.

`src/observablejs/static/`, `dist/`, `docs/_build/`, and
`docs/.jupyter-book-marimo/` are generated. Change their sources and rebuild.
Do not hand-edit or package local build churn.

## Mandatory handoff gate

Run the complete local gate before handing off a repository change:

```sh
make check
```

The `Makefile` target is the canonical full gate. Fix underlying failures. Do
not suppress lint, type, or test errors. Inspect the final diff for unrelated
edits, stale generated files, listener cleanup, cross-language drift, and
accidental private-runtime coupling.

## Verification by boundary

- Test Python behavior through the public `observablejs` API and serialized
  widget state.
- Test TypeScript behavior through runtime, widget, Vite, or DOM contracts that
  consumers depend on. Wait on observable state, not elapsed time.
- Validate visual behavior, notebook rendering, frontend integration, and docs
  pages with `$agent-browser`. Follow
  [Browser checks](development_docs/development.md#browser-checks), then stop
  every browser session and local server.
- Validate `scripts/docs.py` through a fresh wheel-backed build and a served
  interactive page. For deployment-path changes, exercise both `/` and
  `BASE_URL=/pyobservablejs` and confirm the wheel request stays on the served
  origin.

Published docs explain Notebook authoring, frontend use, runtime values, and
source imports. Keep contributor workflows and implementation notes in
`development_docs/`. Comments should explain lifecycle ordering, invariants,
cross-runtime parity, generated-artifact constraints, or bailout reasons. Delete
comments that restate the code.
