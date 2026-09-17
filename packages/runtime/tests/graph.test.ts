import { toNotebook } from "@observablehq/notebook-kit";
import { describe, expect, test } from "vite-plus/test";
import {
	analyzeNotebook,
	createNotebookGraph,
	createNotebookGraphFromAnalysis,
	notebookViewNamesFromAnalysis,
	notebookAffectedIndexes,
	notebookDependencyIndexes,
} from "../src/graph";

describe("notebook graph metadata", () => {
	test("follows upstream and downstream dependencies across branches and cycles", () => {
		const analysis = analyzeNotebook(
			toNotebook({
				cells: ["a = seed", "b = a * 2", "c = a + 1", "d = b + c", "island = other", "x = y", "y = x + seed"].map(
					(value, index) => ({ id: index + 1, mode: "ojs", value }),
				),
			}),
		);
		expect(notebookDependencyIndexes(analysis, [3])).toEqual(new Set([0, 1, 2, 3]));
		expect(notebookAffectedIndexes(analysis, new Set(["a"]))).toEqual(new Set([0, 1, 2, 3]));
		expect(notebookAffectedIndexes(analysis, new Set(["seed"]))).toEqual(new Set([0, 1, 2, 3, 5, 6]));
		expect(notebookDependencyIndexes(analysis, [5])).toEqual(new Set([5, 6]));
		expect(notebookAffectedIndexes(analysis, new Set(["unused"]))).toEqual(new Set());
	});

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
		expectMembers(graph.cells[1]?.references, ["a", "rows"]);
		expect(graph.cells[2]?.output).toBe("viewof$gain");
		expect(graph.cells[2]?.runtimeOutputs).toEqual(["viewof$gain"]);
		expect(graph.cells[2]?.autoview).toBe(true);
		expect(graph.edges).toHaveLength(3);
		expect(graph.edges).toContainEqual({ from: 1, to: 2, variable: "a" });
		expect(graph.edges).toContainEqual({ from: 3, to: 4, variable: "gain" });
		expect(graph.edges).toContainEqual({ from: 2, to: 4, variable: "b" });
	});

	test("reuses analyzed Notebook Kit definitions for graph keys and view names", () => {
		const notebook = toNotebook({
			cells: [
				{ id: 1, mode: "ojs", value: "viewof gain = Inputs.range([0, 10])" },
				{ id: 2, mode: "ojs", value: "gain * 2" },
			],
		});

		const analysis = analyzeNotebook(notebook);
		const graph = createNotebookGraphFromAnalysis(analysis, ["gain", "readout"]);

		expect(Array.from(notebookViewNamesFromAnalysis(analysis))).toEqual(["gain"]);
		expect(graph.cells.map((cell) => cell.key)).toEqual(["gain", "readout"]);
		expect(graph.cells.map((cell) => cell.defines)).toEqual([["gain"], []]);
		expect(graph.edges).toContainEqual({ from: 1, to: 2, variable: "gain" });
	});

	test("preserves raw JS declarations separately from visible variables", () => {
		const notebook = toNotebook({
			cells: [{ id: 1, mode: "js", value: "const x = 1;\nconst y = 2;" }],
		});

		const graph = createNotebookGraph(notebook);

		expectMembers(graph.cells[0]?.defines, ["x", "y"]);
		expectMembers(graph.cells[0]?.outputs, ["x", "y"]);
		expectMembers(graph.cells[0]?.runtimeOutputs, ["x", "y"]);
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
		expectMembers(graph.cells[0]?.runtimeOutputs, ["mutable count", "mutable$count"]);
		expect(graph.cells[0]?.automutable).toBe(true);
		expect(graph.edges).toHaveLength(2);
		expect(graph.edges).toContainEqual({ from: 1, to: 2, variable: "count" });
		expect(graph.edges).toContainEqual({ from: 1, to: 3, variable: "mutable$count" });
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
		expect(graph.cells[0]?.output).toBe(null);
		expect(graph.cells[1]?.defines).toEqual(["title"]);
		expect(graph.cells[1]?.references).toEqual(["md"]);
		expect(graph.cells[2]?.defines).toEqual(["node"]);
		expect(graph.cells[2]?.references).toEqual(["htl"]);
		expect(graph.cells[3]?.defines).toEqual(["rows"]);
		expect(graph.cells[3]?.output).toBe("rows");
		expect(graph.cells[3]?.outputs).toEqual([]);
		expect(graph.cells[3]?.runtimeOutputs).toEqual(["rows"]);
		expect(graph.cells[3]?.autoview).toBe(false);
		expect(graph.cells[4]?.defines).toEqual(["hidden"]);
		expect(graph.cells[4]?.autodisplay).toBe(false);
		expect(graph.edges).toContainEqual({ from: 1, to: 5, variable: "answer" });
	});

	test("keeps imported Observable variables as plural outputs", () => {
		const notebook = toNotebook({
			cells: [{ id: 1, mode: "ojs", value: 'import {foo} from "./foo.js"' }],
		});

		const graph = createNotebookGraph(notebook);

		expect(graph.cells[0]?.defines).toEqual(["foo"]);
		expect(graph.cells[0]?.outputs).toEqual(["foo"]);
	});

	test("tracks aliased import-with bindings and their injection dependencies", () => {
		const notebook = toNotebook({
			cells: [
				{ id: 1, mode: "ojs", value: 'renderSnippetOverride = "override"' },
				{
					id: 2,
					mode: "ojs",
					value: `// imported cells often carry source comments\nimport {Q, viewof showAll, styles as themeStyles} with {renderSnippetOverride as renderSnippet} from "./module.js"`,
				},
			],
		});

		const graph = createNotebookGraph(notebook);

		expect(graph.cells[1]?.defines).toEqual(["Q", "showAll", "viewof$showAll", "themeStyles"]);
		expectMembers(graph.cells[1]?.references, ["@variable", "renderSnippetOverride"]);
		expect(graph.edges).toContainEqual({ from: 1, to: 2, variable: "renderSnippetOverride" });
	});

	test("tracks view and mutable import-with injections", () => {
		for (const [source, injectedName, value] of [
			["filter = true", "filter", 'import {Q} with {viewof filter} from "./module.js"'],
			["mutable count = 1", "count", 'import {Q} with {mutable count as current} from "./module.js"'],
		]) {
			const graph = createNotebookGraph(
				toNotebook({
					cells: [
						{ id: 1, mode: "ojs", value: source },
						{ id: 2, mode: "ojs", value },
					],
				}),
			);

			expectMembers(graph.cells[1]?.references, ["@variable", injectedName]);
			expect(graph.edges).toContainEqual({ from: 1, to: 2, variable: injectedName });
		}
	});

	test("tracks formatted import-with injection dependencies", () => {
		const notebook = toNotebook({
			cells: [
				{ id: 1, mode: "ojs", value: 'injected = "override"' },
				{
					id: 2,
					mode: "ojs",
					value: `import {Q}
	/* bridge */ with\t/* injected */ {
		injected as dependency
	}
from "./module.js"`,
				},
			],
		});

		const graph = createNotebookGraph(notebook);

		expectMembers(graph.cells[1]?.references, ["@variable", "injected"]);
		expect(graph.edges).toContainEqual({ from: 1, to: 2, variable: "injected" });
	});

	test("keeps graph entries for cells with transpile errors", () => {
		const notebook = toNotebook({
			cells: [{ id: 1, mode: "ojs", value: "answer =" }],
		});

		const graph = createNotebookGraph(notebook);

		expect(graph.cells[0]?.id).toBe(1);
		expect(graph.cells[0]?.defines).toEqual([]);
		expect(graph.cells[0]?.error).toMatch(/^SyntaxError: /);
	});
});

function expectMembers(actual: readonly string[] | undefined, expected: string[]): void {
	expect(actual).toHaveLength(expected.length);
	expect(actual).toEqual(expect.arrayContaining(expected));
}
