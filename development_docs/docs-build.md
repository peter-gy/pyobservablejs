# Documentation build

The docs execute every `{marimo}` page against a freshly built wheel. The same
wheel ships with the static site, so browser examples run the package revision
that produced the docs.

```sh
uv run --package pyobservablejs python scripts/docs.py build
```

The command builds the wheel into `dist/docs/`, points each marimo page at that
local file while Jupyter Book executes it, and generates static HTML. It then
copies the wheel into a content-addressed public path and writes its same-origin
path into the generated browser notebook metadata. Browser examples resolve
that path against the current site origin.

Set `BASE_URL` when the site is published below the origin root:

```sh
BASE_URL=/pyobservablejs uv run --package pyobservablejs python scripts/docs.py build
```

The build uses that path for Jupyter Book assets and the wheel URL. For example,
the command above publishes the wheel at
`/pyobservablejs/public/wheels/<sha256>/pyobservablejs-<version>.whl`. Leave
`BASE_URL` unset for a site served from `/`.

Source Markdown keeps the package dependency as `pyobservablejs`. The build
restores every temporary edit before publishing the HTML artifact.

Preview the same static artifact locally:

```sh
uv run --package pyobservablejs python scripts/docs.py serve
```

The preview keeps wheel requests on the preview origin. To exercise a prefixed
deployment locally, pass the same path used by the deployment:

```sh
BASE_URL=/pyobservablejs uv run --package pyobservablejs python scripts/docs.py serve
```

Open `http://127.0.0.1:27331/pyobservablejs/`. Pass `--port` to choose a
different port.
