"""Run an isolated JupyterLab notebook for browser regression tests."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

import nbformat
from jupyterlab.handlers.announcements import NeverCheckForUpdate
from jupyterlab.labapp import LabApp

CELLS = [
    """import observablejs as obs

notebook = obs.Notebook(
    obs.ojs(
        '''viewof threshold = {
            const input = document.createElement("input");
            Object.assign(input, {type: "range", min: "0", max: "1", step: "0.1", value: "0.5"});
            input.setAttribute("aria-label", "Threshold");
            return input;
        }''',
        key="control",
    ),
    obs.js(
        '''const doubled = threshold * 2;
        const summary = document.createElement("strong");
        summary.textContent = `Doubled threshold: ${doubled}`;
        display(summary);''',
        key="summary",
    ),
)
view = notebook.view()

import asyncio

async def read_doubled(expected):
    ready = asyncio.Event()

    def changed(change):
        state = view.state
        if (
            not state.pending
            and state.input_revision is not None
            and state.input_revision == state.settled_revision
            and state.results
        ):
            result = state.result("summary")
            if result.values.get("doubled") == expected:
                ready.set()

    view.observe(changed, names="state")
    try:
        changed(None)
        await asyncio.wait_for(ready.wait(), timeout=10)
        return view.state.result("summary").values["doubled"]
    finally:
        view.unobserve(changed, names="state")

view""",
    """notebook.update_variables({"threshold": 0.8})
print("Python patch applied")""",
    'print("Python patch readback:", await read_doubled(1.6))',
    'print("Browser input readback:", await read_doubled(2))',
    """notebook.close()
try:
    notebook.view()
except RuntimeError:
    print("Notebook session closed")""",
]

DATA_CELLS = [
    """import observablejs as obs
data_notebook = obs.Notebook(
    obs.ojs('rows = [{x: 1, label: "a"}, {x: 2, label: "b"}]', key="records"),
    obs.ojs('count = rows.length', key="count"),
    files={"payload.bin": {"url": "data:application/octet-stream;base64,AQID", "mimeType": "application/octet-stream", "size": 3}},
)
data_view = data_notebook.view("count", capture_state=False)
data_view""",
    """export = await data_view.read("rows", columns=["x"], offset=1, limit=1)
inspection = data_view.inspection
table = export.to_arrow()
datasets = data_view.datasets
attachment = await data_view.read_attachment("payload.bin")
print(f"Data Arrow: rows={table.num_rows} value={int(table.column('x')[0].as_py())}")
print(f"Data catalog: cells={len(inspection.cells)} datasets={len(datasets)}")
print(f"Data bytes: {list(attachment)}")
print(f"Data preview: {data_view.state.input_revision}")""",
    """data_notebook.close()
print("Data session closed")""",
]


ERROR_CELLS = [
    """import observablejs as obs
error_notebook = obs.Notebook(
    obs.ojs('''answer = {
        if (fail) throw new RangeError("sample failed", {cause: new Error("input constraint")});
        return 42;
    }''', key="answer"),
    variables={"fail": True},
)
error_view = error_notebook.view()
error_view""",
    "await error_view.ready(timeout=10)",
    """error_notebook.update_variables({"fail": False})
recovered = await error_view.ready(timeout=10)
print("Recovered:", recovered.result("answer").values["answer"])""",
    """render_notebook = obs.Notebook(
    obs.ojs('''new Proxy({}, {
        ownKeys() { throw new TypeError("inspection probe", {cause: new Error("preview detail")}); }
    })''', key="preview"),
)
render_view = render_notebook.view(capture_state=False)
render_view""",
    "render_view.raise_for_errors()",
    """error_notebook.close()
render_notebook.close()
print("Error sessions closed")""",
]


def main() -> None:
    with TemporaryDirectory(prefix="pyobservablejs-jupyter-") as directory:
        root = Path(directory)
        data = root / "data"
        kernel = data / "kernels" / "pyobservablejs-e2e"
        kernel.mkdir(parents=True)
        (kernel / "kernel.json").write_text(
            json.dumps(
                {
                    "argv": [
                        sys.executable,
                        "-m",
                        "ipykernel_launcher",
                        "-f",
                        "{connection_file}",
                    ],
                    "display_name": "Python 3 (pyobservablejs)",
                    "language": "python",
                }
            ),
            encoding="utf-8",
        )
        labconfig = root / "config" / "labconfig"
        labconfig.mkdir(parents=True)
        (labconfig / "page_config.json").write_text(
            json.dumps(
                {
                    "disabledExtensions": {
                        "@jupyterlab/debugger-extension": True,
                        "@jupyterlab/notebook-extension:language-server": True,
                        "@jupyterlab/fileeditor-extension:language-server": True,
                    }
                }
            ),
            encoding="utf-8",
        )
        settings = root / "settings" / "@jupyterlab" / "apputils-extension"
        settings.mkdir(parents=True)
        (settings / "notification.jupyterlab-settings").write_text(
            json.dumps({"fetchNews": "false", "checkForUpdates": False}),
            encoding="utf-8",
        )
        notebooks = root / "notebooks"
        notebooks.mkdir()
        for filename, cells in (
            ("observablejs.ipynb", CELLS),
            ("data.ipynb", DATA_CELLS),
            ("errors.ipynb", ERROR_CELLS),
        ):
            notebook = nbformat.v4.new_notebook(
                cells=[nbformat.v4.new_code_cell(source) for source in cells],
                metadata={
                    "kernelspec": {
                        "display_name": "Python 3 (pyobservablejs)",
                        "language": "python",
                        "name": "pyobservablejs-e2e",
                    }
                },
            )
            nbformat.write(notebook, notebooks / filename)
        os.environ.update(
            JUPYTER_CONFIG_DIR=str(root / "config"),
            JUPYTER_DATA_DIR=str(data),
            JUPYTER_RUNTIME_DIR=str(root / "runtime"),
        )
        LabApp.launch_instance(
            check_for_updates_class=NeverCheckForUpdate,
            news_url=None,
            argv=[
                "--no-browser",
                "--ServerApp.ip=127.0.0.1",
                "--ServerApp.port=27345",
                "--ServerApp.port_retries=0",
                "--IdentityProvider.token=",
                f"--ServerApp.root_dir={notebooks}",
                f"--LabApp.user_settings_dir={root / 'settings'}",
                f"--LabApp.workspaces_dir={root / 'workspaces'}",
            ],
        )


if __name__ == "__main__":
    main()
