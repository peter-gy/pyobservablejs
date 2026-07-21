# Documentation build

The published site is a Docusaurus application under `apps/docs`. Its `docs/`
directory contains the MDX pages, and the app owns navigation, theme styles,
and browser runtime registration.

```sh
make docs
```

The command runs the Docusaurus production build and writes the site to
`apps/docs/build`. The mdx-marimo remark plugin executes each page's
`python marimo` cells in the uv environment declared by its `marimo-config`
fence. It compiles the cells and Python project metadata into one page-local
notebook for the browser runtime.

Show executable source in a standard `python` fence, then run the same cell in
a `python marimo echo=false server-output=false` fence. Docusaurus highlights
the visible source. The executable fence defers its output until the browser
runtime can create the live anywidget model.

Deploy the contents of `apps/docs/build` directly to a static host. The GitHub
Pages workflow validates the build for pull requests. On `main`, it uploads the
same build as the Pages artifact and deploys it.

The live pages declare `pyobservablejs` as a package dependency. Their build and
browser environments therefore resolve the published package from the package
index. Exercise worktree widget changes through the JupyterLab workflow in
[Development](development.md#browser-checks).

Set `BASE_PATH` when testing a site below the origin root:

```sh
BASE_PATH=/preview make docs
```

The build uses that path for Docusaurus routes and assets. The GitHub Pages
workflow reads the deployment path from `actions/configure-pages` and passes it
to the build. An unset `BASE_PATH` builds the site for `/`.

Build and preview the root-hosted site locally:

```sh
make docs-serve
```

Open `http://127.0.0.1:27331/`.
