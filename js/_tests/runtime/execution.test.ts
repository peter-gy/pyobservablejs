// @vitest-environment jsdom

import { toNotebook } from "@observablehq/notebook-kit";
import { NotebookRuntime } from "@observablehq/notebook-kit/runtime";
import { describe, expect, test } from "vitest";
import { defineRuntimeCell } from "@/runtime/execution";
import { transpileNotebookCell } from "@/runtime/graph";

describe("runtime cell execution", () => {
	test("returns handles that dispose the variables defined by a cell", async () => {
		const cell = toNotebook({ cells: [{ id: 1, mode: "ojs", value: "answer = 42" }] }).cells[0]!;
		const runtime = new NotebookRuntime();

		try {
			const defined = defineRuntimeCell(runtime, document.createElement("div"), cell, transpileNotebookCell(cell));

			await expect(runtime.main.value("answer")).resolves.toBe(42);
			for (const variable of defined.variables) variable.delete();
			await expect(runtime.main.value("answer")).rejects.toThrow();
		} finally {
			runtime.runtime.dispose();
		}
	});
});
