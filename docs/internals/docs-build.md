---
title: Docs build
description: Build and preview the docs with the local wheel.
---

# Docs build

The docs execute rendered `{marimo}` pages against a freshly built wheel. The
same wheel is copied into the static site so deployed examples reference the
package that built the docs.

```sh
uv run python scripts/docs.py build
```

The command:

1. builds a wheel into `dist/docs/`,
2. rewrites rendered docs page dependencies to the local wheel URI,
3. runs `uv run jupyter book build --site` inside `docs/`,
4. copies the wheel to `docs/_build/site/public/pkg/py/pyobservablejs/<sha256>/`,
5. rewrites generated docs metadata and public exports to the static wheel path,
6. restores source Markdown dependencies to `pyobservablejs`.

Preview the same site locally:

```sh
uv run python scripts/docs.py serve
```

The preview temporarily rewrites generated references to
`http://localhost:<port>/pkg/py/pyobservablejs/<sha256>/...`, then restores the
static path when the server stops.

Rendered pages with `{marimo-config}` are discovered from source Markdown and
generated docs metadata.
