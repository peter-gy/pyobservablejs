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

## Docs

Build the Jupyter Book docs:

```sh
uv run python scripts/docs.py build
```

Preview them locally:

```sh
uv run python scripts/docs.py serve
```

## Checks

Before sending changes for review, run:

```sh
make check
```

## Browser Deep Checks

Run the browser deep-check flow in
[Development](development_docs/development.md) when a change touches the widget
frontend, notebook rendering, Observable runtime, Jupyter or marimo integration,
docs site rendering, or user-visible UI.
