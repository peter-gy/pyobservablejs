# Contributing

## Setup

Set up the Python and JavaScript dependencies:

```sh
uv sync --package pyobservablejs --group dev
pnpm install
```

Build the package artifacts:

```sh
make build
```

## Docs

Build the Jupyter Book docs:

```sh
make docs
```

Preview them locally:

```sh
make docs-serve
```

## Checks

Before sending changes for review, run:

```sh
make check
```

## Releases

Run the release script from a clean `main` branch:

```sh
./scripts/release.sh <minor|patch|X.Y.Z>
```

The script updates the package version to `X.Y.Z`, runs the release checks,
builds the package artifacts, creates a release commit, and creates an annotated
`vX.Y.Z` tag. Push the commit and tag when prompted. The `vX.Y.Z` tag starts the
GitHub Actions publish workflow, which uploads the package to PyPI through
Trusted Publishing.

## Browser checks

Run the browser checks in
[Development](development_docs/development.md) when a change touches the widget
frontend, notebook rendering, Observable runtime, Jupyter or marimo integration,
docs site rendering, or user-visible UI.
