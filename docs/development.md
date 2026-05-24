---
title: Development
description: Local setup, docs, and checks for observablejs contributors.
---

# Development

## Setup

Install Python and JavaScript dependencies:

```sh
uv sync --group dev
pnpm install
```

Build the bundled widget assets:

```sh
pnpm build
```

## Workbench

Use the workbench notebooks for manual exploration:

```sh
uv run marimo edit workbench/python_vars.py
uv run marimo edit workbench/gallery_examples.py
```

`workbench/gallery_examples.py` can load the Observable Notebook Kit example
gallery when available:

```sh
OBSERVABLEJS_GALLERY_ROOT=/path/to/notebook-kit/docs/ex uv run marimo edit workbench/gallery_examples.py
```

## Documentation

Build the docs site:

```sh
(cd docs && uv run jupyter book build --site)
```

Preview it locally:

```sh
(cd docs && uv run jupyter book start)
```

The docs use the Jupyter Book 2 / MyST project layout:

- `docs/myst.yml` contains project metadata and the table of contents.
- Markdown pages live directly under `docs/`.
- Generated files are written to `docs/_build/`.

## Checks

Run the Python checks:

```sh
uv run pytest
uv run ruff check
uv run ty check
```

Run the TypeScript checks:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:js
pnpm build
```

Before packaging, also check the staged diff:

```sh
git diff --cached --check
```
