# Documentation build

The published site is a Jupyter Book with executable marimo pages. Each page
with a `{marimo-config}` block declares the Python environment used for its
examples.

```sh
make docs
```

The command runs Jupyter Book in strict HTML mode and writes the site to
`docs/_build/html`. The marimo plugin executes each page in the uv environment
declared by its page-level `pyproject` metadata. It also embeds that metadata in
the generated notebook so the interactive page resolves the same dependencies
in the browser.

The live pages declare `pyobservablejs` as a package dependency. Their build and
browser environments therefore resolve the published package from the package
index. Exercise worktree widget changes through the JupyterLab workflow in
[Development](development.md#browser-checks).

Set `BASE_URL` when the site is published below the origin root:

```sh
BASE_URL=/pyobservablejs make docs
```

The build uses that path for Jupyter Book assets. Leave `BASE_URL` unset for a
site served from `/`.

Build and preview the root-hosted site locally:

```sh
make docs-serve
```

Open `http://127.0.0.1:27331/`.
