// The pure wheel serves anywidget hosts that run Python in Pyodide, such as
// marimo WebAssembly notebooks and JupyterLite.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { loadPyodide } from "pyodide";

const dist = new URL("../../../dist/pure/", import.meta.url);

await test("the pure wheel builds notebooks and views in Pyodide", { timeout: 300_000 }, async () => {
	const wheel = readdirSync(dist).find((name) => name.endsWith("-py3-none-any.whl"));
	assert.ok(wheel, "Run pixi run build-pure to produce dist/pure");
	const pyodide = await loadPyodide();
	await pyodide.loadPackage("micropip");
	pyodide.FS.writeFile(`/tmp/${wheel}`, readFileSync(new URL(wheel, dist)));
	const result = await pyodide.runPythonAsync(`
import micropip
await micropip.install("emfs:/tmp/${wheel}")
import observablejs as obs

notebook = obs.Notebook(obs.ojs("answer = 6 * 7", key="answer"))
view = notebook.view("answer")
try:
    notebook.data["answer"].to_python()
    headless = "evaluated"
except ImportError as error:
    headless = str(error)
[type(view).__name__, view.notebook.cells["answer"].key, headless]
`);
	assert.deepEqual(result.toJs(), [
		"NotebookView",
		"answer",
		"Headless evaluation needs the native pyobservablejs wheel for this platform. " +
			"Notebook views and NotebookView.data work with every wheel.",
	]);
});
