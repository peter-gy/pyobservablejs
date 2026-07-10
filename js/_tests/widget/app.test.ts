// @vitest-environment jsdom

import { describe, expect, test, vi } from "vitest";
import widget from "@/widget/app";
import {
	alertText,
	composedText,
	createHost,
	createModel,
	graphValue,
	renderProps,
	variableValue,
	waitFor,
} from "@/_tests/testing";

describe("widget graph and notebook values", () => {
	test("writes the Notebook Kit graph to the notebook model after child models resolve", async () => {
		const model = createModel({
			role: "notebook",
			_spec: {
				cells: [
					{ id: 1, mode: "ojs", value: "answer = 42" },
					{ id: 2, mode: "ojs", value: "answer + 1" },
				],
			},
			_attachments: {},
			_variables: {},
			_options: {},
			_cell_keys: ["answer", "readout"],
			_cell_widgets: ["anywidget:cell-1", "anywidget:cell-2"],
		});
		const childModels = new Map([
			[
				"anywidget:cell-1",
				createModel({
					role: "cell",
					key: "answer",
					name: "answer",
					_values: {},
					_value_names: [],
				}),
			],
			[
				"anywidget:cell-2",
				createModel({
					role: "cell",
					key: "readout",
					name: "readout",
					_values: {},
					_value_names: [],
				}),
			],
		]);
		const controller = new AbortController();
		const el = document.createElement("div");

		widget.render(renderProps(model, el, controller.signal, createHost(childModels)));

		const graph = await waitFor(() => graphValue(model));

		expect(hasSavedTrait(model, "_graph")).toBe(true);
		expect(graph.cells.map((cell) => cell.key)).toEqual(["answer", "readout"]);
		expect(graph.cells.map((cell) => cell.defines)).toEqual([["answer"], []]);
		expect(graph.cells[1]?.references).toEqual(["answer"]);
		expect(graph.edges).toHaveLength(1);
		expect(graph.edges).toContainEqual({ from: 1, to: 2, variable: "answer" });
		expect(await waitFor(() => (model.get("_has_rendered") === true ? true : undefined))).toBe(true);
		controller.abort();
	});

	test("resets child readback when rerender interrupts pending model resolution", async () => {
		const model = createModel({
			role: "notebook",
			_spec: {
				cells: [
					{ id: 1, mode: "ojs", value: "answer = 42" },
					{ id: 2, mode: "ojs", value: "answer + 1" },
				],
			},
			_attachments: {},
			_variables: {},
			_options: {},
			_cell_widgets: ["anywidget:answer", "anywidget:pending"],
		});
		const answer = createModel({
			role: "cell",
			name: "answer",
			_values: {},
			_value_names: [],
		});
		const pending = new Promise<ReturnType<typeof createModel>>(() => {});
		const childModels = new Map<string, ReturnType<typeof createModel> | Promise<ReturnType<typeof createModel>>>([
			["anywidget:answer", answer],
			["anywidget:pending", pending],
		]);
		const controller = new AbortController();
		const el = document.createElement("div");

		widget.render(renderProps(model, el, controller.signal, createHost(childModels)));
		expect(await waitFor(() => (answer.get("_has_rendered") === true ? true : undefined))).toBe(true);

		model.set("_cell_widgets", ["anywidget:answer"]);
		await waitFor(() => alertText(el));

		expect(answer.get("_has_rendered")).toBe(false);
		expect(answer.get("_value_names")).toEqual([]);
		expect(answer.get("_values")).toEqual({});
		controller.abort();
	});

	test("keeps notebook values reactive to slider-like child variable updates", async () => {
		const model = createModel({
			role: "notebook",
			_spec: {
				cells: [
					{
						id: 1,
						mode: "ojs",
						value: "gain = 5",
					},
					{ id: 2, mode: "ojs", value: "gain * 2" },
				],
			},
			_attachments: {},
			_variables: {},
			_options: {},
			_cell_widgets: ["anywidget:gain", "anywidget:readout"],
		});
		const childModels = new Map([
			[
				"anywidget:gain",
				createModel({
					role: "cell",
					name: "gain",
					_values: {},
					_value_names: [],
				}),
			],
			[
				"anywidget:readout",
				createModel({
					role: "cell",
					name: "readout",
					_values: {},
					_value_names: [],
				}),
			],
		]);
		const controller = new AbortController();
		const el = document.createElement("div");

		widget.render(renderProps(model, el, controller.signal, createHost(childModels)));
		await waitFor(() => graphValue(model));

		const gainModel = childModels.get("anywidget:gain");
		gainModel?.set("_value_names", ["gain"]);
		gainModel?.set("_values", { gain: 5 });
		expect(await waitFor(() => variableValue(model, "gain"))).toBe(5);

		gainModel?.set("_values", { gain: 7.5 });
		const changedGain = await waitFor(() => (variableValue(model, "gain") === 7.5 ? 7.5 : undefined));

		childModels.get("anywidget:readout")?.set("_value_names", ["readout"]);
		childModels.get("anywidget:readout")?.set("_values", { readout: 15 });

		expect(changedGain).toBe(7.5);
		expect(await waitFor(() => (variableValue(model, "readout") === 15 ? 15 : undefined))).toBe(15);
		controller.abort();
	});

	test("keeps notebook and child surfaces stable across repeated Python variable updates", async () => {
		const model = createModel({
			role: "notebook",
			_spec: {
				cells: [
					{ id: 1, mode: "ojs", value: "baseEcho = base" },
					{ id: 2, mode: "ojs", value: "doubled = base * 2" },
				],
			},
			_attachments: {},
			_variables: { base: 1 },
			_options: {},
			_cell_widgets: ["anywidget:base", "anywidget:doubled"],
		});
		const baseModel = createModel({
			role: "cell",
			name: "baseEcho",
			_values: {},
			_value_names: [],
		});
		const doubledModel = createModel({
			role: "cell",
			name: "doubled",
			_values: {},
			_value_names: [],
		});
		const childModels = new Map([
			["anywidget:base", baseModel],
			["anywidget:doubled", doubledModel],
		]);
		const controller = new AbortController();
		const el = document.createElement("div");

		widget.render(renderProps(model, el, controller.signal, createHost(childModels)));

		const root = await waitFor(() => (el.firstElementChild instanceof HTMLElement ? el.firstElementChild : undefined));
		await waitFor(() => composedText(el, "2"));
		expect(await waitFor(() => (variableValue(model, "doubled") === 2 ? 2 : undefined))).toBe(2);

		setVariableUpdate(model, 1, { base: 3 });
		expect(await waitFor(() => (variableValue(model, "doubled") === 6 ? 6 : undefined))).toBe(6);
		setVariableUpdate(model, 2, { base: 5 });
		expect(await waitFor(() => (variableValue(model, "doubled") === 10 ? 10 : undefined))).toBe(10);
		setVariableUpdate(model, 3, { base: 8 });
		expect(await waitFor(() => (variableValue(model, "doubled") === 16 ? 16 : undefined))).toBe(16);

		expect(el.firstElementChild).toBe(root);
		await waitFor(() => composedText(el, "16"));
		controller.abort();
	});

	test("syncs named display cell values under the cell name", async () => {
		const model = createModel({
			role: "notebook",
			_spec: {
				cells: [
					{ id: 1, mode: "ojs", value: "answer = 42" },
					{ id: 2, mode: "ojs", value: "answer + 1" },
				],
			},
			_attachments: {},
			_variables: {},
			_options: {},
			_cell_widgets: ["anywidget:answer", "anywidget:readout"],
		});
		const readoutModel = createModel({
			role: "cell",
			name: "readout",
			_values: {},
			_value_names: [],
		});
		const childModels = new Map([
			[
				"anywidget:answer",
				createModel({
					role: "cell",
					key: "answer",
					name: "answer",
					_values: {},
					_value_names: [],
				}),
			],
			["anywidget:readout", readoutModel],
		]);
		const controller = new AbortController();
		const el = document.createElement("div");

		widget.render(renderProps(model, el, controller.signal, createHost(childModels)));

		expect(await waitFor(() => (variableValue(readoutModel, "readout") === 43 ? 43 : undefined))).toBe(43);
		expect(await waitFor(() => (variableValue(model, "readout") === 43 ? 43 : undefined))).toBe(43);
		expect(hasSavedTrait(readoutModel, "_value_names")).toBe(true);
		expect(hasSavedTrait(readoutModel, "_values")).toBe(true);
		expect(hasSavedTrait(model, "_values")).toBe(true);
		controller.abort();
	});

	test("syncs named display cell errors under the cell name", async () => {
		const model = createModel({
			role: "notebook",
			_spec: {
				cells: [{ id: 1, mode: "ojs", value: "missing + 1" }],
			},
			_attachments: {},
			_variables: {},
			_options: {},
			_cell_widgets: ["anywidget:readout"],
		});
		const readoutModel = createModel({
			role: "cell",
			name: "readout",
			_values: {},
			_value_names: [],
		});
		const childModels = new Map([["anywidget:readout", readoutModel]]);
		const controller = new AbortController();

		widget.render(renderProps(model, document.createElement("div"), controller.signal, createHost(childModels)));

		const error = await waitFor(() => variableValue(readoutModel, "readout") as Record<string, unknown> | undefined);
		expect(
			await waitFor(() =>
				Array.isArray(readoutModel.get("_value_names")) ? (readoutModel.get("_value_names") as string[]) : undefined,
			),
		).toEqual(["readout"]);
		expect(hasSavedTrait(readoutModel, "_value_names")).toBe(true);
		expect(hasSavedTrait(readoutModel, "_values")).toBe(true);
		expect(hasSavedTrait(model, "_values")).toBe(true);
		expect(error.__observablejs_type__).toBe("error");
		expect(error.name).toBe("RuntimeError");
		expect(String(error.message)).toContain("missing is not defined");
		expect(await waitFor(() => variableValue(model, "readout") as Record<string, unknown> | undefined)).toEqual(error);
		controller.abort();
	});

	test("lets Python variables override notebook-defined variables", async () => {
		const model = createModel({
			role: "notebook",
			_spec: {
				cells: [
					{ id: 1, mode: "ojs", value: "answer = 1" },
					{ id: 2, mode: "ojs", value: "doubled = answer * 2" },
				],
			},
			_attachments: {},
			_variables: { answer: 41, unused: 1 },
			_options: {},
			_cell_widgets: ["anywidget:answer", "anywidget:doubled"],
		});
		const childModels = new Map([
			[
				"anywidget:answer",
				createModel({
					role: "cell",
					name: "answer",
					_values: {},
					_value_names: [],
				}),
			],
			[
				"anywidget:doubled",
				createModel({
					role: "cell",
					name: "doubled",
					_values: {},
					_value_names: [],
				}),
			],
		]);
		const controller = new AbortController();
		const el = document.createElement("div");

		widget.render(renderProps(model, el, controller.signal, createHost(childModels)));

		await waitFor(() => composedText(el, "41"));
		await waitFor(() => composedText(el, "82"));
		expect(
			await waitFor(() => (variableValue(childModels.get("anywidget:answer")!, "answer") === 41 ? 41 : undefined)),
		).toBe(41);
		expect(await waitFor(() => (variableValue(model, "doubled") === 82 ? 82 : undefined))).toBe(82);
		controller.abort();
	});

	test("uses initial Python variable overrides before evaluating source definitions", async () => {
		const evaluateSourceAnswer = vi.fn(() => 1);
		Object.defineProperty(globalThis, "__pyobservablejsEvaluateSourceAnswer", {
			configurable: true,
			value: evaluateSourceAnswer,
		});
		const model = createModel({
			role: "notebook",
			_spec: {
				cells: [
					{
						id: 1,
						mode: "ojs",
						value: "answer = globalThis.__pyobservablejsEvaluateSourceAnswer()",
					},
					{ id: 2, mode: "ojs", value: "doubled = answer * 2" },
				],
			},
			_attachments: {},
			_variables: { answer: 41 },
			_options: {},
			_cell_widgets: ["anywidget:answer", "anywidget:doubled"],
		});
		const childModels = new Map([
			[
				"anywidget:answer",
				createModel({
					role: "cell",
					name: "answer",
					_values: {},
					_value_names: [],
				}),
			],
			[
				"anywidget:doubled",
				createModel({
					role: "cell",
					name: "doubled",
					_values: {},
					_value_names: [],
				}),
			],
		]);
		const controller = new AbortController();
		const el = document.createElement("div");

		try {
			widget.render(renderProps(model, el, controller.signal, createHost(childModels)));

			await waitFor(() => composedText(el, "41"));
			await waitFor(() => composedText(el, "82"));
			expect(
				await waitFor(() => (variableValue(childModels.get("anywidget:answer")!, "answer") === 41 ? 41 : undefined)),
			).toBe(41);
			expect(await waitFor(() => (variableValue(model, "doubled") === 82 ? 82 : undefined))).toBe(82);
			expect(evaluateSourceAnswer).not.toHaveBeenCalled();
		} finally {
			controller.abort();
			Reflect.deleteProperty(globalThis, "__pyobservablejsEvaluateSourceAnswer");
		}
	});

	test("overrides source-backed variables without breaking URL-backed attachments", async () => {
		const model = createModel({
			role: "notebook",
			_source: `
<notebook>
  <script id="1" type="application/vnd.observable.javascript" name="rows">rows = [{x: 0}, {x: 1}, {x: 2}]</script>
  <script id="2" type="application/vnd.observable.javascript" name="count">count = rows.length</script>
  <script id="3" type="application/vnd.observable.javascript" name="attachmentUrl">attachmentUrl = FileAttachment("points.csv").url()</script>
</notebook>
`,
			_attachments: {
				"points.csv": {
					url: "https://static.example/points.csv",
					mimeType: "text/csv",
				},
			},
			_variables: { rows: [{ x: 10 }, { x: 20 }], unused: 1 },
			_options: {},
			_cell_widgets: ["anywidget:rows", "anywidget:count", "anywidget:attachment"],
		});
		const childModels = new Map([
			[
				"anywidget:rows",
				createModel({
					role: "cell",
					name: "rows",
					_values: {},
					_value_names: [],
				}),
			],
			[
				"anywidget:count",
				createModel({
					role: "cell",
					name: "count",
					_values: {},
					_value_names: [],
				}),
			],
			[
				"anywidget:attachment",
				createModel({
					role: "cell",
					name: "attachmentUrl",
					_values: {},
					_value_names: [],
				}),
			],
		]);
		const controller = new AbortController();

		widget.render(renderProps(model, document.createElement("div"), controller.signal, createHost(childModels)));

		expect(await waitFor(() => (variableValue(model, "count") === 2 ? 2 : undefined))).toBe(2);
		expect(await waitFor(() => variableValue(model, "rows") as Array<{ x: number }> | undefined)).toEqual([
			{ x: 10 },
			{ x: 20 },
		]);
		expect(await waitFor(() => variableValue(model, "attachmentUrl") as string | undefined)).toBe(
			"https://static.example/points.csv",
		);
		controller.abort();
	});

	test("syncs graph metadata for source-backed Notebook Kit HTML", async () => {
		const model = createModel({
			role: "notebook",
			_source: `
<notebook>
  <script id="1" type="application/vnd.observable.javascript" name="answer">answer = 42</script>
  <script id="2" type="module" name="double">const double = answer * 2;</script>
</notebook>
`,
			_attachments: {},
			_variables: {},
			_options: {},
			_cell_keys: ["answer", "double"],
			_cell_widgets: ["anywidget:source-1", "anywidget:source-2"],
		});
		const childModels = new Map([
			[
				"anywidget:source-1",
				createModel({
					role: "cell",
					key: "answer",
					name: "answer",
					_values: {},
					_value_names: [],
				}),
			],
			[
				"anywidget:source-2",
				createModel({
					role: "cell",
					key: "double",
					name: "double",
					_values: {},
					_value_names: [],
				}),
			],
		]);
		const controller = new AbortController();

		widget.render(renderProps(model, document.createElement("div"), controller.signal, createHost(childModels)));

		const graph = await waitFor(() => graphValue(model));

		expect(graph.cells.map((cell) => cell.id)).toEqual([1, 2]);
		expect(graph.cells.map((cell) => cell.key)).toEqual(["answer", "double"]);
		expect(graph.cells[1]?.defines).toEqual(["double"]);
		expect(graph.cells[1]?.references).toEqual(["answer"]);
		expect(graph.edges).toHaveLength(1);
		expect(graph.edges).toContainEqual({ from: 1, to: 2, variable: "answer" });
		controller.abort();
	});
});

function hasSavedTrait(model: ReturnType<typeof createModel>, name: string): boolean {
	return model.savedTraits.has(name);
}

function setVariableUpdate(model: ReturnType<typeof createModel>, seq: number, values: Record<string, unknown>): void {
	const previous = model.get("_variables");
	model.set("_variable_update", { seq, kind: "set", values });
	model.set("_variables", previous && typeof previous === "object" ? { ...previous, ...values } : values);
}
