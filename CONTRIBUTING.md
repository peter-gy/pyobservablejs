# Contributing

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
uv run marimo edit workbench/construction_methods.py
uv run marimo edit workbench/observable_urls.py
```

`workbench/gallery_examples.py` can load the Observable Notebook Kit example
gallery when available:

```sh
NOTEBOOK_KIT_GALLERY_ROOT=/path/to/notebook-kit/docs/ex uv run marimo edit workbench/gallery_examples.py
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
