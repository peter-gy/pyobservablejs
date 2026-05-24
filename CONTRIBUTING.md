# Contributing

Thanks for helping improve `observablejs`.

## Setup

Set up the Python and JavaScript dependencies:

```sh
uv sync --group dev
pnpm install
```

Build the widget bundle:

```sh
pnpm build
```

## Workbench

Run the marimo workbench notebooks from the project environment:

```sh
uv run marimo edit workbench/python_vars.py
uv run marimo edit workbench/gallery_examples.py
```

`workbench/gallery_examples.py` can load the Observable Notebook Kit example
gallery when available:

```sh
OBSERVABLEJS_GALLERY_ROOT=/path/to/notebook-kit/docs/ex uv run marimo edit workbench/gallery_examples.py
```

## Docs

Build the Jupyter Book docs:

```sh
(cd docs && uv run jupyter book build --site)
```

Preview them locally:

```sh
(cd docs && uv run jupyter book start)
```

## Checks

Before sending changes for review, run:

```sh
uv run pytest
uv run ruff check
uv run ty check
pnpm format:check
pnpm lint
pnpm typecheck
```
