// @vitest-environment jsdom

import type { RenderProps } from "@anywidget/types";
import { describe, expect, test } from "vitest";
import type { NotebookGraph } from "./observable/types";
import { SELECTORS } from "./widget/dom-contract";
import type { WidgetModel } from "./widget/types";
import widget from "./widget";
import { composedText } from "./widget-dom-test-utils";
import { createHost, createModel, hasSavedTrait, variableValue, waitFor } from "./widget-test-utils";

describe("widget graph and notebook values", () => {
	test("writes the Notebook Kit graph to the notebook model after child models resolve", async () => {
		const model = createModel({
			role: "notebook",
			spec: {
				cells: [
					{ id: 1, mode: "ojs", value: "answer = 42" },
					{ id: 2, mode: "ojs", value: "answer + 1" },
				],
			},
			attachments: {},
			_variables: {},
			options: {},
			_cell_widgets: ["anywidget:cell-1", "anywidget:cell-2"],
		});
		const childModels = new Map([
			[
				"anywidget:cell-1",
				createModel({
					role: "cell",
					name: "answer",
					_values: {},
					_value_names: [],
				}),
			],
			[
				"anywidget:cell-2",
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

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: createHost(childModels),
		} as unknown as RenderProps<WidgetModel>);

		const graph = await waitFor(() => model.get("_graph") as NotebookGraph | undefined);

		expect(hasSavedTrait(model, "_graph")).toBe(true);
		expect(graph.cells.map((cell) => cell.name)).toEqual(["answer", "readout"]);
		expect(graph.cells.map((cell) => cell.defines)).toEqual([["answer"], []]);
		expect(graph.cells[1]?.references).toEqual(["answer"]);
		expect(graph.edges).toHaveLength(1);
		expect(graph.edges).toContainEqual({ from: 1, to: 2, variable: "answer" });
		controller.abort();
	});

	test("keeps notebook values reactive to slider-like child variable updates", async () => {
		const model = createModel({
			role: "notebook",
			spec: {
				cells: [
					{
						id: 1,
						mode: "ojs",
						value: "viewof gain = Inputs.range([0, 11], {value: 5})",
					},
					{ id: 2, mode: "ojs", value: "gain * 2" },
				],
			},
			attachments: {},
			_variables: {},
			options: {},
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

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: createHost(childModels),
		} as unknown as RenderProps<WidgetModel>);
		await waitFor(() => model.get("_graph") as NotebookGraph | undefined);

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

	test("syncs named display cell values under the cell name", async () => {
		const model = createModel({
			role: "notebook",
			spec: {
				cells: [
					{ id: 1, mode: "ojs", value: "answer = 42" },
					{ id: 2, mode: "ojs", value: "answer + 1" },
				],
			},
			attachments: {},
			_variables: {},
			options: {},
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
					name: "answer",
					_values: {},
					_value_names: [],
				}),
			],
			["anywidget:readout", readoutModel],
		]);
		const controller = new AbortController();
		const el = document.createElement("div");

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: createHost(childModels),
		} as unknown as RenderProps<WidgetModel>);

		expect(await waitFor(() => (variableValue(readoutModel, "readout") === 43 ? 43 : undefined))).toBe(43);
		expect(await waitFor(() => (variableValue(model, "readout") === 43 ? 43 : undefined))).toBe(43);
		expect(hasSavedTrait(readoutModel, "_value_names")).toBe(true);
		expect(hasSavedTrait(readoutModel, "_values")).toBe(true);
		expect(hasSavedTrait(model, "_value_names")).toBe(true);
		expect(hasSavedTrait(model, "_values")).toBe(true);
		controller.abort();
	});

	test("syncs named display cell errors under the cell name", async () => {
		const model = createModel({
			role: "notebook",
			spec: {
				cells: [{ id: 1, mode: "ojs", value: "missing + 1" }],
			},
			attachments: {},
			_variables: {},
			options: {},
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

		widget.render({
			model,
			el: document.createElement("div"),
			signal: controller.signal,
			host: createHost(childModels),
		} as unknown as RenderProps<WidgetModel>);

		const error = await waitFor(() => variableValue(readoutModel, "readout") as Record<string, unknown> | undefined);
		expect(
			await waitFor(() =>
				Array.isArray(readoutModel.get("_value_names")) ? (readoutModel.get("_value_names") as string[]) : undefined,
			),
		).toEqual(["readout"]);
		expect(
			await waitFor(() =>
				Array.isArray(model.get("_value_names")) ? (model.get("_value_names") as string[]) : undefined,
			),
		).toEqual(["readout"]);
		expect(hasSavedTrait(readoutModel, "_value_names")).toBe(true);
		expect(hasSavedTrait(readoutModel, "_values")).toBe(true);
		expect(hasSavedTrait(model, "_value_names")).toBe(true);
		expect(hasSavedTrait(model, "_values")).toBe(true);
		expect(error.__pyobservablejs_type__).toBe("error");
		expect(error.name).toBe("RuntimeError");
		expect(String(error.message)).toContain("missing is not defined");
		expect(await waitFor(() => variableValue(model, "readout") as Record<string, unknown> | undefined)).toEqual(error);
		controller.abort();
	});

	test("lets Python variables override notebook-defined variables", async () => {
		const model = createModel({
			role: "notebook",
			spec: {
				cells: [
					{ id: 1, mode: "ojs", value: "answer = 1" },
					{ id: 2, mode: "ojs", value: "doubled = answer * 2" },
				],
			},
			attachments: {},
			_variables: { answer: 41, unused: 1 },
			options: {},
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

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: createHost(childModels),
		} as unknown as RenderProps<WidgetModel>);

		await waitFor(() => composedText(el, "41"));
		await waitFor(() => composedText(el, "82"));
		expect(
			await waitFor(() => (variableValue(childModels.get("anywidget:answer")!, "answer") === 41 ? 41 : undefined)),
		).toBe(41);
		expect(await waitFor(() => (variableValue(model, "doubled") === 82 ? 82 : undefined))).toBe(82);
		controller.abort();
	});

	test("uses initial Python variable overrides when source definitions would fail", async () => {
		const model = createModel({
			role: "notebook",
			spec: {
				cells: [
					{
						id: 1,
						mode: "ojs",
						value: 'answer = { throw new Error("source answer evaluated"); }',
					},
					{ id: 2, mode: "ojs", value: "doubled = answer * 2" },
				],
			},
			attachments: {},
			_variables: { answer: 41 },
			options: {},
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

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: createHost(childModels),
		} as unknown as RenderProps<WidgetModel>);

		await waitFor(() => composedText(el, "41"));
		await waitFor(() => composedText(el, "82"));
		expect(
			await waitFor(() => (variableValue(childModels.get("anywidget:answer")!, "answer") === 41 ? 41 : undefined)),
		).toBe(41);
		expect(await waitFor(() => (variableValue(model, "doubled") === 82 ? 82 : undefined))).toBe(82);
		expect(el.querySelector(SELECTORS.error)?.textContent).toBeUndefined();
		controller.abort();
	});

	test("overrides source-backed variables without breaking URL-backed attachments", async () => {
		const model = createModel({
			role: "notebook",
			source: `
<notebook>
  <script id="1" type="application/vnd.observable.javascript" name="rows">rows = [{x: 0}, {x: 1}, {x: 2}]</script>
  <script id="2" type="application/vnd.observable.javascript" name="count">count = rows.length</script>
  <script id="3" type="application/vnd.observable.javascript" name="attachmentUrl">attachmentUrl = FileAttachment("points.csv").url()</script>
</notebook>
`,
			attachments: {
				"points.csv": {
					url: "https://static.example/points.csv",
					mimeType: "text/csv",
				},
			},
			_variables: { rows: [{ x: 10 }, { x: 20 }], unused: 1 },
			options: {},
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

		widget.render({
			model,
			el: document.createElement("div"),
			signal: controller.signal,
			host: createHost(childModels),
		} as unknown as RenderProps<WidgetModel>);

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
			source: `
<notebook>
  <script id="1" type="application/vnd.observable.javascript" name="answer">answer = 42</script>
  <script id="2" type="module" name="double">const double = answer * 2;</script>
</notebook>
`,
			attachments: {},
			_variables: {},
			options: {},
			_cell_widgets: ["anywidget:source-1", "anywidget:source-2"],
		});
		const childModels = new Map([
			[
				"anywidget:source-1",
				createModel({
					role: "cell",
					name: "answer",
					_values: {},
					_value_names: [],
				}),
			],
			[
				"anywidget:source-2",
				createModel({
					role: "cell",
					name: "double",
					_values: {},
					_value_names: [],
				}),
			],
		]);
		const controller = new AbortController();

		widget.render({
			model,
			el: document.createElement("div"),
			signal: controller.signal,
			host: createHost(childModels),
		} as unknown as RenderProps<WidgetModel>);

		const graph = await waitFor(() => model.get("_graph") as NotebookGraph | undefined);

		expect(graph.cells.map((cell) => cell.id)).toEqual([1, 2]);
		expect(graph.cells.map((cell) => cell.name)).toEqual(["answer", "double"]);
		expect(graph.cells[1]?.defines).toEqual(["double"]);
		expect(graph.cells[1]?.references).toEqual(["answer"]);
		expect(graph.edges).toHaveLength(1);
		expect(graph.edges).toContainEqual({ from: 1, to: 2, variable: "answer" });
		controller.abort();
	});
});
