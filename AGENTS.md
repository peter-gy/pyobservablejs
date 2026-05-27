# pyobservablejs

## Mandatory Handoff Gates

Before handing off any repository change, run the full local gate and make every
check pass:

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

Do not suppress lint, type, or test failures to make the gate pass. Fix the
underlying issue, keep the diff focused, and remove generated notebook/server
churn before handoff.

## Code QA

Always inspect the final diff before handoff. Check for behavior regressions,
unrelated refactors, stale generated files, missing tests, listener cleanup
issues, and accidental use of private runtime internals. The Python side should
communicate with the frontend through traitlets and anywidget mechanisms; do not
use marimo internals as an escape hatch.

## Browser Deep Checks

Use the `$agent-browser` skill explicitly for browser-level verification when
touching the widget frontend, notebook rendering, Observable runtime behavior,
Jupyter/marimo integration, docs site rendering, or any user-visible UI.

For notebook/runtime changes, the default deep check is:

```sh
uv run jupyter lab --no-browser --port 27273 --ServerApp.token='' --ServerApp.password=''
uv run marimo run --no-sandbox --headless --no-token --port 27271 workbench/python_vars.py
NOTEBOOK_KIT_GALLERY_ROOT=/Users/petergy/Projects/opensource/observablehq/notebook-kit/docs/ex \
  uv run marimo run --no-sandbox --headless --no-token --port 27272 workbench/gallery_examples.py
```

Then verify with `agent-browser` that:

- `example.ipynb` can restart/run-all in JupyterLab and renders the Observable
  title plus Plot output.
- `workbench/python_vars.py` renders without browser errors, and interactive OJS
  values propagate back to Python-visible `notebook.values`.
- `workbench/gallery_examples.py` renders the default gallery example and can
  switch to another example without console or page errors.

Use `agent-browser console`, `agent-browser errors`, DOM/shadow-DOM inspection,
and screenshots where useful. Stop local servers and browser sessions before
handoff.
