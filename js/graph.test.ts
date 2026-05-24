// @vitest-environment jsdom

import { toNotebook } from "@observablehq/notebook-kit";
import { describe, expect, test } from "vitest";
import { createNotebookGraph } from "./graph";

describe("notebook graph metadata", () => {
	test("uses Notebook Kit transpile metadata for references, outputs, and edges", () => {
		const notebook = toNotebook({
			cells: [
				{ id: 1, mode: "ojs", value: "a = 1" },
				{ id: 2, mode: "ojs", value: "b = a + rows.length" },
				{ id: 3, mode: "ojs", value: "viewof gain = Inputs.range([0, 10])" },
				{ id: 4, mode: "ojs", value: "gain * b" },
			],
		});

		const graph = createNotebookGraph(notebook, ["a", "b", "gain", "readout"]);

		expect(graph.cells.map((cell) => cell.defines)).toEqual([["a"], ["b"], ["gain"], []]);
		expect(graph.cells[1]?.references).toEqual(["a", "rows"]);
		expect(graph.cells[2]?.output).toBe("viewof$gain");
		expect(graph.cells[2]?.runtime_outputs).toEqual(["viewof$gain"]);
		expect(graph.cells[2]?.autoview).toBe(true);
		expect(graph.edges).toEqual([
			{ from: 1, to: 2, name: "a" },
			{ from: 3, to: 4, name: "gain" },
			{ from: 2, to: 4, name: "b" },
		]);
	});

	test("preserves raw JS declarations separately from visible variables", () => {
		const notebook = toNotebook({
			cells: [{ id: 1, mode: "js", value: "const x = 1;\nconst y = 2;" }],
		});

		const graph = createNotebookGraph(notebook);

		expect(graph.cells[0]?.defines).toEqual(["x", "y"]);
		expect(graph.cells[0]?.outputs).toEqual(["x", "y"]);
		expect(graph.cells[0]?.runtime_outputs).toEqual(["x", "y"]);
		expect(graph.cells[0]?.output).toBe(null);
	});

	test("records mutable aliases used by Notebook Kit references", () => {
		const notebook = toNotebook({
			cells: [
				{ id: 1, mode: "ojs", value: "mutable count = 0" },
				{ id: 2, mode: "ojs", value: "count + 1" },
				{ id: 3, mode: "ojs", value: "mutable count" },
			],
		});

		const graph = createNotebookGraph(notebook);

		expect(graph.cells[0]?.defines).toEqual(["count"]);
		expect(graph.cells[0]?.output).toBe("mutable count");
		expect(graph.cells[0]?.runtime_outputs).toEqual(["mutable count", "mutable$count"]);
		expect(graph.cells[0]?.automutable).toBe(true);
		expect(graph.edges).toEqual([
			{ from: 1, to: 2, name: "count" },
			{ from: 1, to: 3, name: "mutable$count" },
		]);
	});

	test("uses Notebook Kit output metadata for module, template, SQL, and hidden cells", () => {
		const notebook = toNotebook({
			cells: [
				{ id: 1, mode: "js", value: "const answer = 42;", output: "answer" },
				{ id: 2, mode: "md", value: "# Title", output: "title" },
				{ id: 3, mode: "html", value: "<b>Hi</b>", output: "node" },
				{ id: 4, mode: "sql", value: "select 1 as x", output: "rows" },
				{ id: 5, mode: "ojs", value: "hidden = answer + 1", hidden: true },
			],
		});

		const graph = createNotebookGraph(notebook);

		expect(graph.cells[0]?.defines).toEqual(["answer"]);
		expect(graph.cells[0]?.outputs).toEqual(["answer"]);
		expect(graph.cells[0]?.output).toBe("answer");
		expect(graph.cells[1]?.defines).toEqual(["title"]);
		expect(graph.cells[1]?.references).toEqual(["md"]);
		expect(graph.cells[2]?.defines).toEqual(["node"]);
		expect(graph.cells[2]?.references).toEqual(["html"]);
		expect(graph.cells[3]?.defines).toEqual(["rows"]);
		expect(graph.cells[3]?.output).toBe("viewof$rows");
		expect(graph.cells[3]?.runtime_outputs).toEqual(["viewof$rows"]);
		expect(graph.cells[3]?.autoview).toBe(true);
		expect(graph.cells[4]?.defines).toEqual(["hidden"]);
		expect(graph.cells[4]?.autodisplay).toBe(false);
		expect(graph.edges).toContainEqual({ from: 1, to: 5, name: "answer" });
	});

	test("keeps imported Observable variables as plural outputs", () => {
		const notebook = toNotebook({
			cells: [{ id: 1, mode: "ojs", value: 'import {foo} from "./foo.js"' }],
		});

		const graph = createNotebookGraph(notebook);

		expect(graph.cells[0]?.defines).toEqual(["foo"]);
		expect(graph.cells[0]?.outputs).toEqual(["foo"]);
		expect(graph.cells[0]?.references).toEqual(["__ojs_runtime", "__ojs_observer"]);
	});

	test("keeps graph entries for cells with transpile errors", () => {
		const notebook = toNotebook({
			cells: [{ id: 1, mode: "ojs", value: "answer =" }],
		});

		const graph = createNotebookGraph(notebook);

		expect(graph.cells[0]?.id).toBe(1);
		expect(graph.cells[0]?.defines).toEqual([]);
		expect(graph.cells[0]?.error).toContain("SyntaxError");
	});
});
