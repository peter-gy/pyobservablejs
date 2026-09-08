import assert from "node:assert/strict";
import test from "node:test";
import { inspectNotebook } from "@pyobservablejs/runtime/inspect";

await test("inspects a Notebook Kit specification through the built Node entry point", () => {
	const info = inspectNotebook({
		title: "Batch inspection",
		cells: [
			{ id: 1, mode: "ojs", value: 'rows = FileAttachment("rows.csv").csv()' },
			{ id: 2, mode: "ojs", value: "total = rows.length" },
			{ id: 3, mode: "ojs", value: 'import {chart} from "@example/chart"' },
		],
	});
	assert.equal(info.title, "Batch inspection");
	assert.deepEqual(info.cells[0].files, ["rows.csv"]);
	assert.deepEqual(info.graph.edges, [{ from: 1, to: 2, variable: "rows" }]);
	assert.equal(info.imports[0].resolved, "https://api.observablehq.com/@example/chart.js?v=4");
});
