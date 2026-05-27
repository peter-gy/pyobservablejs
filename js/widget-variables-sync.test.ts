// @vitest-environment jsdom

import type { RenderProps } from "@anywidget/types";
import { toNotebook } from "@observablehq/notebook-kit";
import { describe, expect, test } from "vitest";
import { SELECTORS } from "./dom-contract";
import type { CellRenderContext, WidgetModel } from "./types";
import widget from "./widget";
import {
	countingChildRenders,
	createCellExports,
	createCellExportsMap,
	createHost,
	createModel,
	variableValue,
	waitFor,
} from "./widget-test-utils";

describe("widget runtime variable sync", () => {
	test("updates Python variables through the runtime without rerendering the notebook", async () => {
		const model = createModel({
			role: "notebook",
			spec: {
				cells: [
					{ id: 1, mode: "ojs", value: "base_echo = base" },
					{ id: 2, mode: "ojs", value: "doubled = base * 2" },
				],
			},
			attachments: {},
			_variables: { base: 2 },
			options: {},
			_cell_widgets: ["anywidget:base", "anywidget:doubled"],
		});
		const childModels = new Map([
			["anywidget:base", createModel({ role: "cell", name: "base_echo", _values: {}, _value_names: [] })],
			["anywidget:doubled", createModel({ role: "cell", name: "doubled", _values: {}, _value_names: [] })],
		]);
		const renderCounts = new Map<string, number>();
		const childRenders = countingChildRenders(childModels, renderCounts);
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: createHost(childModels, createCellExportsMap(childModels), childRenders),
		} as unknown as RenderProps<WidgetModel>);

		const firstCell = await waitFor(() => el.querySelector<HTMLElement>(SELECTORS.composedCell) ?? undefined);
		expect(await waitFor(() => (variableValue(model, "doubled") === 4 ? 4 : undefined))).toBe(4);

		setVariables(model, 1, "set", { base: 5 });

		expect(await waitFor(() => (variableValue(model, "doubled") === 10 ? 10 : undefined))).toBe(10);
		expect(variableValue(model, "base_echo")).toBe(5);
		expect(el.querySelector(SELECTORS.composedCell)).toBe(firstCell);
		expect(renderCounts).toEqual(
			new Map([
				["anywidget:base", 1],
				["anywidget:doubled", 1],
			]),
		);
		controller.abort();
	});

	test("defines newly added Python variables without rerendering the notebook", async () => {
		const model = createModel({
			role: "notebook",
			spec: {
				cells: [
					{ id: 1, mode: "ojs", value: "base_echo = base" },
					{ id: 2, mode: "ojs", value: "doubled = base * 2" },
				],
			},
			attachments: {},
			_variables: {},
			options: {},
			_cell_widgets: ["anywidget:base", "anywidget:doubled"],
		});
		const childModels = new Map([
			["anywidget:base", createModel({ role: "cell", name: "base_echo", _values: {}, _value_names: [] })],
			["anywidget:doubled", createModel({ role: "cell", name: "doubled", _values: {}, _value_names: [] })],
		]);
		const renderCounts = new Map<string, number>();
		const childRenders = countingChildRenders(childModels, renderCounts);
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: createHost(childModels, createCellExportsMap(childModels), childRenders),
		} as unknown as RenderProps<WidgetModel>);
		await waitFor(() => el.querySelector(SELECTORS.composedCell) ?? undefined);

		setVariables(model, 1, "set", { base: 6 });

		expect(await waitFor(() => (variableValue(model, "doubled") === 12 ? 12 : undefined))).toBe(12);
		expect(variableValue(model, "base_echo")).toBe(6);
		expect(renderCounts).toEqual(
			new Map([
				["anywidget:base", 1],
				["anywidget:doubled", 1],
			]),
		);
		controller.abort();
	});

	test("rerenders when Python variables replacement removes keys", async () => {
		const model = createModel({
			role: "notebook",
			spec: {
				cells: [
					{ id: 1, mode: "ojs", value: "base = 1" },
					{ id: 2, mode: "ojs", value: "doubled = base * 2" },
				],
			},
			attachments: {},
			_variables: { base: 5 },
			options: {},
			_cell_widgets: ["anywidget:base", "anywidget:doubled"],
		});
		const childModels = new Map([
			["anywidget:base", createModel({ role: "cell", name: "base", _values: {}, _value_names: [] })],
			["anywidget:doubled", createModel({ role: "cell", name: "doubled", _values: {}, _value_names: [] })],
		]);
		const renderCounts = new Map<string, number>();
		const childRenders = countingChildRenders(childModels, renderCounts);
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: createHost(childModels, createCellExportsMap(childModels), childRenders),
		} as unknown as RenderProps<WidgetModel>);

		const firstCell = await waitFor(() => el.querySelector<HTMLElement>(SELECTORS.composedCell) ?? undefined);
		expect(await waitFor(() => (variableValue(model, "doubled") === 10 ? 10 : undefined))).toBe(10);

		setVariables(model, 1, "replace", {});

		expect(await waitFor(() => (variableValue(model, "doubled") === 2 ? 2 : undefined))).toBe(2);
		expect(el.querySelector(SELECTORS.composedCell)).not.toBe(firstCell);
		expect(renderCounts).toEqual(
			new Map([
				["anywidget:base", 2],
				["anywidget:doubled", 2],
			]),
		);
		controller.abort();
	});

	test("updates viewof variables by mutating the existing control", async () => {
		const model = createModel({
			role: "notebook",
			spec: {
				cells: [
					{
						id: 1,
						mode: "ojs",
						value: `
viewof gain = {
  const input = document.createElement("input");
  input.type = "range";
  input.min = "0";
  input.max = "10";
  input.value = "1";
  return input;
}`,
					},
					{ id: 2, mode: "ojs", value: "doubled = gain * 2" },
				],
			},
			attachments: {},
			_variables: { gain: 5 },
			options: {},
			_cell_widgets: ["anywidget:gain", "anywidget:doubled"],
		});
		const childModels = new Map([
			["anywidget:gain", createModel({ role: "cell", name: "gain", _values: {}, _value_names: [] })],
			["anywidget:doubled", createModel({ role: "cell", name: "doubled", _values: {}, _value_names: [] })],
		]);
		const renderCounts = new Map<string, number>();
		const childRenders = countingChildRenders(childModels, renderCounts);
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: createHost(childModels, createCellExportsMap(childModels), childRenders),
		} as unknown as RenderProps<WidgetModel>);

		const input = await waitFor(() => {
			const error = el.querySelector(SELECTORS.error)?.textContent;
			if (error) throw new Error(error);
			return el.querySelector<HTMLInputElement>("input[type='range']") ?? undefined;
		});
		await waitFor(() => (input.valueAsNumber === 5 ? input : undefined));
		expect(await waitFor(() => (variableValue(model, "doubled") === 10 ? 10 : undefined))).toBe(10);

		setVariables(model, 1, "set", { gain: 7 });

		await waitFor(() => (input.valueAsNumber === 7 ? input : undefined));
		expect(await waitFor(() => (variableValue(model, "doubled") === 14 ? 14 : undefined))).toBe(14);
		expect(renderCounts).toEqual(
			new Map([
				["anywidget:gain", 1],
				["anywidget:doubled", 1],
			]),
		);
		controller.abort();
	});

	test("replaces the tracked viewof target when a cell returns a new control", async () => {
		const model = createModel({
			role: "notebook",
			spec: {
				cells: [
					{
						id: 1,
						mode: "ojs",
						value: `
viewof gain = {
  const input = document.createElement("input");
  input.type = "range";
  input.min = "0";
  input.max = "10";
  input.value = String(seed);
  return input;
}`,
					},
					{ id: 2, mode: "ojs", value: "doubled = gain * 2" },
				],
			},
			attachments: {},
			_variables: { seed: 1, gain: 5 },
			options: {},
			_cell_widgets: ["anywidget:gain", "anywidget:doubled"],
		});
		const childModels = new Map([
			["anywidget:gain", createModel({ role: "cell", name: "gain", _values: {}, _value_names: [] })],
			["anywidget:doubled", createModel({ role: "cell", name: "doubled", _values: {}, _value_names: [] })],
		]);
		const renderCounts = new Map<string, number>();
		const childRenders = countingChildRenders(childModels, renderCounts);
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: createHost(childModels, createCellExportsMap(childModels), childRenders),
		} as unknown as RenderProps<WidgetModel>);

		const firstInput = await waitFor(() => el.querySelector<HTMLInputElement>("input[type='range']") ?? undefined);
		await waitFor(() => (firstInput.valueAsNumber === 5 ? firstInput : undefined));

		setVariables(model, 1, "set", { seed: 2 });
		const secondInput = await waitFor(() => {
			const input = el.querySelector<HTMLInputElement>("input[type='range']");
			return input && input !== firstInput ? input : undefined;
		});
		await waitFor(() => (secondInput.valueAsNumber === 5 ? secondInput : undefined));

		setVariables(model, 2, "set", { gain: 7 });

		await waitFor(() => (secondInput.valueAsNumber === 7 ? secondInput : undefined));
		expect(firstInput.valueAsNumber).toBe(5);
		expect(await waitFor(() => (variableValue(model, "doubled") === 14 ? 14 : undefined))).toBe(14);
		expect(renderCounts).toEqual(
			new Map([
				["anywidget:gain", 1],
				["anywidget:doubled", 1],
			]),
		);
		controller.abort();
	});

	test("cleans isolated standalone variable listeners when variable removal resets a view", async () => {
		const notebookModel = createModel({
			role: "notebook",
			_variables: { seed: 5, gain: 2 },
			_values: {},
			_value_names: [],
		});
		const seedModel = createModel({
			role: "cell",
			name: "seed",
			_values: { seed: 1 },
			_value_names: ["seed"],
		});
		const gainModel = createModel({
			role: "cell",
			name: "gain",
			_values: {},
			_value_names: [],
		});
		const notebook = toNotebook({
			cells: [
				{ id: 1, mode: "ojs", value: "seed = 1" },
				{
					id: 2,
					mode: "ojs",
					value: `
viewof gain = {
  const input = document.createElement("input");
  input.type = "range";
  input.min = "0";
  input.max = "10";
  input.value = String(seed);
  return input;
}`,
				},
			],
		});
		createCellExports(gainModel).bindRuntime({
			notebookModel,
			runtime: {} as CellRenderContext["runtime"],
			showSource: false,
			cell: notebook.cells[1],
			cellIndex: 1,
			notebook,
			options: { attachments: {}, baseUrl: document.baseURI, variables: { seed: 5, gain: 2 }, showSource: false },
			cellModels: [seedModel, gainModel],
			sync: {} as CellRenderContext["sync"],
		});
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render({
			model: gainModel,
			el,
			signal: controller.signal,
			host: createHost(new Map()),
		} as unknown as RenderProps<WidgetModel>);

		const firstInput = await waitFor(() => el.querySelector<HTMLInputElement>("input[type='range']") ?? undefined);
		await waitFor(() => (firstInput.valueAsNumber === 2 ? firstInput : undefined));
		expect(notebookModel.listenerCount("change:_variable_update")).toBe(1);

		setVariables(notebookModel, 1, "replace", { gain: 3 });
		const secondInput = await waitFor(() => {
			const input = el.querySelector<HTMLInputElement>("input[type='range']");
			return input && input !== firstInput && input.valueAsNumber === 3 ? input : undefined;
		});

		expect(notebookModel.listenerCount("change:_variable_update")).toBe(1);
		setVariables(notebookModel, 2, "set", { gain: 4 });
		await waitFor(() => (secondInput.valueAsNumber === 4 ? secondInput : undefined));
		expect(notebookModel.listenerCount("change:_variable_update")).toBe(1);
		controller.abort();
		expect(notebookModel.listenerCount("change:_variable_update")).toBe(0);
	});
});

function setVariables(
	model: ReturnType<typeof createModel>,
	seq: number,
	kind: "set" | "replace",
	values: Record<string, unknown>,
): void {
	const previous = model.get("_variables");
	model.set(
		"_variables",
		kind === "set" && previous && typeof previous === "object" ? { ...previous, ...values } : values,
	);
	model.set("_variable_update", { seq, kind, values });
}
