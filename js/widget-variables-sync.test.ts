// @vitest-environment jsdom

import type { RenderProps } from "@anywidget/types";
import { toNotebook } from "@observablehq/notebook-kit";
import { describe, expect, test } from "vitest";
import { SELECTORS } from "./widget/dom-contract";
import type { CellRenderContext, WidgetModel } from "./widget/types";
import widget from "./widget";
import {
	createCellExports,
	createCellExportsMap,
	createHost,
	createModel,
	objectValuedSelectSource,
	renderChildrenThroughWidget,
	variableValue,
	waitFor,
} from "./widget-test-utils";

describe("widget runtime variable sync", () => {
	test("updates existing Python variables through the runtime", async () => {
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
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: createHost(childModels, createCellExportsMap(childModels), renderChildrenThroughWidget(childModels)),
		} as unknown as RenderProps<WidgetModel>);

		expect(await waitFor(() => (variableValue(model, "doubled") === 4 ? 4 : undefined))).toBe(4);

		setVariables(model, 1, "set", { base: 5 });

		expect(await waitFor(() => (variableValue(model, "doubled") === 10 ? 10 : undefined))).toBe(10);
		expect(variableValue(model, "base_echo")).toBe(5);
		controller.abort();
	});

	test("defines newly added Python variables through the runtime", async () => {
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
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: createHost(childModels, createCellExportsMap(childModels), renderChildrenThroughWidget(childModels)),
		} as unknown as RenderProps<WidgetModel>);
		setVariables(model, 1, "set", { base: 6 });

		expect(await waitFor(() => (variableValue(model, "doubled") === 12 ? 12 : undefined))).toBe(12);
		expect(variableValue(model, "base_echo")).toBe(6);
		controller.abort();
	});

	test("restores source definitions when Python variable replacement removes keys", async () => {
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
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: createHost(childModels, createCellExportsMap(childModels), renderChildrenThroughWidget(childModels)),
		} as unknown as RenderProps<WidgetModel>);

		expect(await waitFor(() => (variableValue(model, "doubled") === 10 ? 10 : undefined))).toBe(10);

		setVariables(model, 1, "replace", {});

		expect(await waitFor(() => (variableValue(model, "doubled") === 2 ? 2 : undefined))).toBe(2);
		controller.abort();
	});

	test("updates viewof variable values through the runtime", async () => {
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
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: createHost(childModels, createCellExportsMap(childModels), renderChildrenThroughWidget(childModels)),
		} as unknown as RenderProps<WidgetModel>);

		await waitFor(() => {
			const error = el.querySelector(SELECTORS.error)?.textContent;
			if (error) throw new Error(error);
			return rangeWithValue(el, 5);
		});
		expect(await waitFor(() => (variableValue(model, "doubled") === 10 ? 10 : undefined))).toBe(10);

		setVariables(model, 1, "set", { gain: 7 });

		await waitFor(() => rangeWithValue(el, 7));
		expect(await waitFor(() => (variableValue(model, "doubled") === 14 ? 14 : undefined))).toBe(14);
		controller.abort();
	});

	test("updates object-valued viewof variables through nested selects", async () => {
		const model = createModel({
			role: "notebook",
			spec: {
				cells: [
					{
						id: 1,
						mode: "ojs",
						value: objectValuedSelectSource,
					},
					{ id: 2, mode: "ojs", value: "presetsArray = [{pointDensity: 7}, {pointDensity: 21}]" },
					{ id: 3, mode: "ojs", value: "viewof presets = Select(presetsArray, {value: presetsArray[0]})" },
					{ id: 4, mode: "ojs", value: "pointDensity = presets ? presets.pointDensity : -1" },
				],
			},
			attachments: {},
			_variables: {},
			options: {},
			_cell_widgets: ["anywidget:select", "anywidget:presets-array", "anywidget:presets", "anywidget:point-density"],
		});
		const childModels = new Map([
			["anywidget:select", createModel({ role: "cell", name: "select", _values: {}, _value_names: [] })],
			["anywidget:presets-array", createModel({ role: "cell", name: "presetsArray", _values: {}, _value_names: [] })],
			["anywidget:presets", createModel({ role: "cell", name: "presets", _values: {}, _value_names: [] })],
			["anywidget:point-density", createModel({ role: "cell", name: "pointDensity", _values: {}, _value_names: [] })],
		]);
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: createHost(childModels, createCellExportsMap(childModels), renderChildrenThroughWidget(childModels)),
		} as unknown as RenderProps<WidgetModel>);

		const select = await waitFor(() => onlySelect(el));
		expect(await waitFor(() => (variableValue(model, "pointDensity") === 7 ? 7 : undefined))).toBe(7);

		setVariables(model, 1, "set", { presets: { pointDensity: 21 } });

		await waitFor(() => (variableValue(model, "pointDensity") === 21 ? 21 : undefined));
		expect(select.selectedIndex).toBe(1);
		expect(select.closest("form")?.value).toEqual({ pointDensity: 21 });
		controller.abort();
	});

	test("keeps Python-owned view values while dependencies change", async () => {
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
					{ id: 2, mode: "ojs", value: "seedEcho = seed" },
					{ id: 3, mode: "ojs", value: "doubled = gain * 2" },
				],
			},
			attachments: {},
			_variables: { seed: 1, gain: 5 },
			options: {},
			_cell_widgets: ["anywidget:gain", "anywidget:seed-echo", "anywidget:doubled"],
		});
		const childModels = new Map([
			["anywidget:gain", createModel({ role: "cell", name: "gain", _values: {}, _value_names: [] })],
			["anywidget:seed-echo", createModel({ role: "cell", name: "seedEcho", _values: {}, _value_names: [] })],
			["anywidget:doubled", createModel({ role: "cell", name: "doubled", _values: {}, _value_names: [] })],
		]);
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: createHost(childModels, createCellExportsMap(childModels), renderChildrenThroughWidget(childModels)),
		} as unknown as RenderProps<WidgetModel>);

		await waitFor(() => rangeWithValue(el, 5));
		expect(await waitFor(() => (variableValue(model, "seedEcho") === 1 ? 1 : undefined))).toBe(1);

		setVariables(model, 1, "set", { seed: 2 });
		await waitFor(() => rangeWithValue(el, 5));
		expect(await waitFor(() => (variableValue(model, "seedEcho") === 2 ? 2 : undefined))).toBe(2);

		setVariables(model, 2, "set", { gain: 7 });

		await waitFor(() => rangeWithValue(el, 7));
		expect(await waitFor(() => (variableValue(model, "doubled") === 14 ? 14 : undefined))).toBe(14);
		controller.abort();
	});

	test("preserves user-set view values across repeated dependency replacements", async () => {
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
					{ id: 2, mode: "ojs", value: "seedEcho = seed" },
					{ id: 3, mode: "ojs", value: "doubled = gain * 2" },
				],
			},
			attachments: {},
			_variables: { seed: 1 },
			options: {},
			_cell_widgets: ["anywidget:gain", "anywidget:seed-echo", "anywidget:doubled"],
		});
		const childModels = new Map([
			["anywidget:gain", createModel({ role: "cell", name: "gain", _values: {}, _value_names: [] })],
			["anywidget:seed-echo", createModel({ role: "cell", name: "seedEcho", _values: {}, _value_names: [] })],
			["anywidget:doubled", createModel({ role: "cell", name: "doubled", _values: {}, _value_names: [] })],
		]);
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: createHost(childModels, createCellExportsMap(childModels), renderChildrenThroughWidget(childModels)),
		} as unknown as RenderProps<WidgetModel>);

		const firstInput = await waitFor(() => rangeWithValue(el, 1));
		expect(await waitFor(() => (variableValue(model, "seedEcho") === 1 ? 1 : undefined))).toBe(1);
		firstInput.value = "5";
		firstInput.dispatchEvent(new Event("input", { bubbles: true }));
		firstInput.dispatchEvent(new Event("change", { bubbles: true }));
		await waitFor(() => (variableValue(model, "gain") === 5 ? 5 : undefined));

		setVariables(model, 1, "set", { seed: 2 });
		await waitFor(() => rangeWithValue(el, 5));
		expect(await waitFor(() => (variableValue(model, "seedEcho") === 2 ? 2 : undefined))).toBe(2);

		setVariables(model, 2, "set", { seed: 3 });
		await waitFor(() => rangeWithValue(el, 5));
		expect(await waitFor(() => (variableValue(model, "seedEcho") === 3 ? 3 : undefined))).toBe(3);
		expect(await waitFor(() => (variableValue(model, "doubled") === 10 ? 10 : undefined))).toBe(10);
		controller.abort();
	});

	test("uses replacement view defaults until the user changes the view", async () => {
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
			_variables: { seed: 1 },
			options: {},
			_cell_widgets: ["anywidget:gain", "anywidget:doubled"],
		});
		const childModels = new Map([
			["anywidget:gain", createModel({ role: "cell", name: "gain", _values: {}, _value_names: [] })],
			["anywidget:doubled", createModel({ role: "cell", name: "doubled", _values: {}, _value_names: [] })],
		]);
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: createHost(childModels, createCellExportsMap(childModels), renderChildrenThroughWidget(childModels)),
		} as unknown as RenderProps<WidgetModel>);

		await waitFor(() => rangeWithValue(el, 1));
		expect(await waitFor(() => (variableValue(model, "doubled") === 2 ? 2 : undefined))).toBe(2);

		setVariables(model, 1, "set", { seed: 2 });
		await waitFor(() => rangeWithValue(el, 2));
		expect(await waitFor(() => (variableValue(model, "doubled") === 4 ? 4 : undefined))).toBe(4);

		setVariables(model, 2, "set", { seed: 3 });
		await waitFor(() => rangeWithValue(el, 3));
		expect(await waitFor(() => (variableValue(model, "doubled") === 6 ? 6 : undefined))).toBe(6);
		controller.abort();
	});

	test("uses view defaults after Python replacement removes a view value", async () => {
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
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: createHost(childModels, createCellExportsMap(childModels), renderChildrenThroughWidget(childModels)),
		} as unknown as RenderProps<WidgetModel>);

		const firstInput = await waitFor(() => rangeWithValue(el, 5));
		expect(await waitFor(() => (variableValue(model, "doubled") === 10 ? 10 : undefined))).toBe(10);
		firstInput.value = "6";
		firstInput.dispatchEvent(new Event("input", { bubbles: true }));
		firstInput.dispatchEvent(new Event("change", { bubbles: true }));
		await waitFor(() => (variableValue(model, "doubled") === 12 ? 12 : undefined));

		setVariables(model, 1, "replace", { seed: 2 });
		await waitFor(() => rangeWithValue(el, 2));
		expect(await waitFor(() => (variableValue(model, "doubled") === 4 ? 4 : undefined))).toBe(4);

		setVariables(model, 2, "set", { seed: 3 });
		await waitFor(() => rangeWithValue(el, 3));
		expect(await waitFor(() => (variableValue(model, "doubled") === 6 ? 6 : undefined))).toBe(6);
		controller.abort();
	});

	test("stops standalone variable updates after abort", async () => {
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
			options: {
				attachments: {},
				baseUrl: document.baseURI,
				variables: { seed: 5, gain: 2 },
				showSource: false,
				observableMarkdownCompatibility: false,
			},
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

		await waitFor(() => rangeWithValue(el, 2));

		setVariables(notebookModel, 1, "replace", { gain: 3 });
		await waitFor(() => rangeWithValue(el, 3));

		setVariables(notebookModel, 2, "set", { gain: 4 });
		const acceptedRange = await waitFor(() => rangeWithValue(el, 4));
		controller.abort();
		setVariables(notebookModel, 3, "set", { gain: 9 });

		await flushRuntimeUpdates();
		expect(acceptedRange.valueAsNumber).toBe(4);
		expect(rangeWithValue(el, 9)).toBeUndefined();
	});
});

async function flushRuntimeUpdates(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function rangeWithValue(el: HTMLElement, value: number): HTMLInputElement | undefined {
	const inputs = Array.from(el.querySelectorAll<HTMLInputElement>("input[type='range']"));
	if (inputs.length === 0) return undefined;
	if (inputs.length > 1) throw new Error(`Expected one range input, found ${inputs.length}`);
	const [input] = inputs;
	return input?.valueAsNumber === value ? input : undefined;
}

function onlySelect(el: HTMLElement): HTMLSelectElement | undefined {
	const selects = Array.from(el.querySelectorAll<HTMLSelectElement>("select"));
	if (selects.length === 0) return undefined;
	if (selects.length > 1) throw new Error(`Expected one select, found ${selects.length}`);
	return selects[0]!;
}

function setVariables(
	model: ReturnType<typeof createModel>,
	seq: number,
	kind: "set" | "replace",
	values: Record<string, unknown>,
): void {
	const previous = model.get("_variables");
	model.set("_variable_update", { seq, kind, values });
	model.set(
		"_variables",
		kind === "set" && previous && typeof previous === "object" ? { ...previous, ...values } : values,
	);
}
