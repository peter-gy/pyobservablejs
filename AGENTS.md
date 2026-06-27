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
uv run python scripts/docs.py build
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
uv run python scripts/docs.py serve
```

Then verify with `agent-browser` that:

- `example.ipynb` can restart/run-all in JupyterLab and renders the Observable
  title plus Plot output.
- the docs pages with `{marimo}` blocks render their pyobservablejs widgets.
- `tutorials/python-variables` updates the Observable Plot when the Python
  slider changes without remounting the widget output.

Use `agent-browser console`, `agent-browser errors`, DOM/shadow-DOM inspection,
and screenshots where useful. Stop local servers and browser sessions before
handoff.
