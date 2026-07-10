// @vitest-environment jsdom

import { describe, expect, test } from "vitest";
import widget from "@/widget/app";
import {
	alertText,
	composedText,
	createHost,
	createModel,
	renderProps,
	variableValue,
	waitFor,
} from "@/_tests/testing";

const objectValuedSelectSource = `
Select = (items, options = {}) => {
  const form = document.createElement("form");
  const select = document.createElement("select");
  let selected = options.value ?? items[0];
  for (const [index, item] of items.entries()) {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = String(item.pointDensity);
    select.appendChild(option);
  }
  select.value = String(items.indexOf(selected));
  const update = () => {
    selected = items[select.selectedIndex] ?? null;
  };
  select.addEventListener("input", update);
  select.addEventListener("change", update);
  Object.defineProperty(form, "value", {
    get() { return selected; },
    set(value) {
      selected = items.includes(value) ? value : null;
      select.selectedIndex = items.indexOf(value);
    },
  });
  form.appendChild(select);
  return form;
}`;

describe("widget variable sync", () => {
	test("updates existing Python variables through the runtime", async () => {
		const model = createModel({
			role: "notebook",
			_spec: {
				cells: [
					{ id: 1, mode: "ojs", value: "base_echo = base" },
					{ id: 2, mode: "ojs", value: "doubled = base * 2" },
				],
			},
			_attachments: {},
			_variables: { base: 2 },
			_options: {},
			_cell_widgets: ["anywidget:base", "anywidget:doubled"],
		});
		const childModels = new Map([
			["anywidget:base", createModel({ role: "cell", name: "base_echo", _values: {}, _value_names: [] })],
			["anywidget:doubled", createModel({ role: "cell", name: "doubled", _values: {}, _value_names: [] })],
		]);
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render(renderProps(model, el, controller.signal, createHost(childModels)));

		expect(await waitFor(() => (variableValue(model, "doubled") === 4 ? 4 : undefined))).toBe(4);
		await waitFor(() => composedText(el, "4"));

		setVariables(model, 1, "set", { base: 5 });

		expect(await waitFor(() => (variableValue(model, "doubled") === 10 ? 10 : undefined))).toBe(10);
		expect(variableValue(model, "base_echo")).toBe(5);
		await waitFor(() => composedText(el, "10"));
		controller.abort();
	});

	test("rejects live variables that collide with active compatibility builtins", async () => {
		const model = createModel({
			role: "notebook",
			_spec: {
				cells: [{ id: 1, mode: "ojs", value: "answer = 42" }],
			},
			_attachments: {},
			_variables: {},
			_options: { runtime_compatibility: { require: true } },
			_cell_widgets: ["anywidget:answer"],
		});
		const childModels = new Map([
			["anywidget:answer", createModel({ role: "cell", name: "answer", _values: {}, _value_names: [] })],
		]);
		const controller = new AbortController();

		widget.render(renderProps(model, document.createElement("div"), controller.signal, createHost(childModels)));

		await waitFor(() => (variableValue(model, "answer") === 42 ? 42 : undefined));

		expect(() => setVariables(model, 1, "set", { require: "shadowed" })).toThrow(
			"Python variables cannot override Observable runtime builtins: require",
		);
		controller.abort();
	});

	test("keeps Python-owned hidden cells hidden", async () => {
		const model = createModel({
			role: "notebook",
			_spec: {
				cells: [{ id: 1, mode: "ojs", value: "answer = 1", hidden: true }],
			},
			_attachments: {},
			_variables: { answer: 41 },
			_options: {},
			_cell_widgets: ["anywidget:answer"],
		});
		const childModels = new Map([
			["anywidget:answer", createModel({ role: "cell", name: "answer", _values: {}, _value_names: [] })],
		]);
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render(renderProps(model, el, controller.signal, createHost(childModels)));

		expect(await waitFor(() => (variableValue(model, "answer") === 41 ? 41 : undefined))).toBe(41);
		expect(el.textContent.trim()).toBe("");
		controller.abort();
	});

	test("uses Python-owned outputs from mixed JS declarations", async () => {
		const model = createModel({
			role: "notebook",
			_spec: {
				cells: [
					{
						id: 1,
						mode: "js",
						value: 'const answer = 1; const label = "source label";',
					},
				],
			},
			_attachments: {},
			_variables: { answer: 41 },
			_options: {},
			_cell_widgets: ["anywidget:mixed"],
		});
		const childModel = createModel({ role: "cell", name: "mixed", _values: {}, _value_names: [] });
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render(renderProps(model, el, controller.signal, createHost(new Map([["anywidget:mixed", childModel]]))));

		expect(await waitFor(() => (variableValue(childModel, "answer") === 41 ? 41 : undefined))).toBe(41);
		expect(
			await waitFor(() => (variableValue(childModel, "label") === "source label" ? "source label" : undefined)),
		).toBe("source label");
		expect(variableValue(model, "answer")).toBe(41);
		expect(variableValue(model, "label")).toBe("source label");

		setVariables(model, 1, "set", { answer: 43 });

		expect(await waitFor(() => (variableValue(childModel, "answer") === 43 ? 43 : undefined))).toBe(43);
		expect(variableValue(childModel, "label")).toBe("source label");
		controller.abort();
	});

	test("defines newly added Python variables through the runtime", async () => {
		const model = createModel({
			role: "notebook",
			_spec: {
				cells: [
					{ id: 1, mode: "ojs", value: "base_echo = base" },
					{ id: 2, mode: "ojs", value: "doubled = base * 2" },
				],
			},
			_attachments: {},
			_variables: {},
			_options: {},
			_cell_widgets: ["anywidget:base", "anywidget:doubled"],
		});
		const childModels = new Map([
			["anywidget:base", createModel({ role: "cell", name: "base_echo", _values: {}, _value_names: [] })],
			["anywidget:doubled", createModel({ role: "cell", name: "doubled", _values: {}, _value_names: [] })],
		]);
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render(renderProps(model, el, controller.signal, createHost(childModels)));
		setVariables(model, 1, "set", { base: 6 });

		expect(await waitFor(() => (variableValue(model, "doubled") === 12 ? 12 : undefined))).toBe(12);
		expect(variableValue(model, "base_echo")).toBe(6);
		controller.abort();
	});

	test("restores source definitions when Python variable replacement removes keys", async () => {
		const model = createModel({
			role: "notebook",
			_spec: {
				cells: [
					{ id: 1, mode: "ojs", value: "base = 1" },
					{ id: 2, mode: "ojs", value: "doubled = base * 2" },
				],
			},
			_attachments: {},
			_variables: { base: 5 },
			_options: {},
			_cell_widgets: ["anywidget:base", "anywidget:doubled"],
		});
		const childModels = new Map([
			["anywidget:base", createModel({ role: "cell", name: "base", _values: {}, _value_names: [] })],
			["anywidget:doubled", createModel({ role: "cell", name: "doubled", _values: {}, _value_names: [] })],
		]);
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render(renderProps(model, el, controller.signal, createHost(childModels)));

		expect(await waitFor(() => (variableValue(model, "doubled") === 10 ? 10 : undefined))).toBe(10);

		setVariables(model, 1, "replace", {});

		expect(await waitFor(() => (variableValue(model, "doubled") === 2 ? 2 : undefined))).toBe(2);
		controller.abort();
	});

	test("updates viewof variable values through the runtime", async () => {
		const model = createModel({
			role: "notebook",
			_spec: {
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
			_attachments: {},
			_variables: { gain: 5 },
			_options: {},
			_cell_widgets: ["anywidget:gain", "anywidget:doubled"],
		});
		const childModels = new Map([
			["anywidget:gain", createModel({ role: "cell", name: "gain", _values: {}, _value_names: [] })],
			["anywidget:doubled", createModel({ role: "cell", name: "doubled", _values: {}, _value_names: [] })],
		]);
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render(renderProps(model, el, controller.signal, createHost(childModels)));

		await waitFor(() => {
			const error = alertText(el);
			if (error) throw new Error(error);
			return rangeWithValue(el, 5);
		});
		expect(await waitFor(() => (variableValue(model, "doubled") === 10 ? 10 : undefined))).toBe(10);

		setVariables(model, 1, "set", { gain: 7 });

		await waitFor(() => rangeWithValue(el, 7));
		expect(await waitFor(() => (variableValue(model, "doubled") === 14 ? 14 : undefined))).toBe(14);
		controller.abort();
	});

	test("routes unsupported view writes through runtime variables", async () => {
		const model = createModel({
			role: "notebook",
			_spec: {
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
  input.value = "5";
  return input;
}`,
					},
					{ id: 2, mode: "ojs", value: "gainKind = typeof gain" },
				],
			},
			_attachments: {},
			_variables: { gain: { pointDensity: 21 } },
			_options: {},
			_cell_widgets: ["anywidget:gain", "anywidget:gain-kind"],
		});
		const childModels = new Map([
			["anywidget:gain", createModel({ role: "cell", name: "gain", _values: {}, _value_names: [] })],
			["anywidget:gain-kind", createModel({ role: "cell", name: "gainKind", _values: {}, _value_names: [] })],
		]);
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render(renderProps(model, el, controller.signal, createHost(childModels)));

		await waitFor(() => rangeWithValue(el, 5));
		expect(await waitFor(() => (variableValue(model, "gainKind") === "object" ? "object" : undefined))).toBe("object");
		controller.abort();
	});

	test("updates object-valued viewof variables through nested selects", async () => {
		const model = createModel({
			role: "notebook",
			_spec: {
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
			_attachments: {},
			_variables: {},
			_options: {},
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

		widget.render(renderProps(model, el, controller.signal, createHost(childModels)));

		const select = await waitFor(() => onlySelect(el));
		expect(await waitFor(() => (variableValue(model, "pointDensity") === 7 ? 7 : undefined))).toBe(7);

		setVariables(model, 1, "set", { presets: { pointDensity: 21 } });

		await waitFor(() => (variableValue(model, "pointDensity") === 21 ? 21 : undefined));
		expect(select.selectedIndex).toBe(1);
		expect(select.closest("form")?.value).toEqual({ pointDensity: 21 });
		controller.abort();
	});

	test("does not replay lossy element summaries into view controls", async () => {
		const model = createModel({
			role: "notebook",
			_spec: {
				cells: [
					{
						id: 1,
						mode: "ojs",
						value: `
viewof image = {
  const form = document.createElement("form");
  form.value = Promise.resolve(document.createElement("img"));
  return form;
}`,
					},
					{ id: 2, mode: "ojs", value: "imageTag = image.tagName" },
				],
			},
			_attachments: {},
			_variables: {},
			_options: {},
			_cell_widgets: ["anywidget:image", "anywidget:image-tag"],
		});
		const childModels = new Map([
			["anywidget:image", createModel({ role: "cell", name: "image", _values: {}, _value_names: [] })],
			["anywidget:image-tag", createModel({ role: "cell", name: "imageTag", _values: {}, _value_names: [] })],
		]);
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render(renderProps(model, el, controller.signal, createHost(childModels)));

		const form = await waitFor(() => el.querySelector("form") ?? undefined);
		expect(await waitFor(() => (variableValue(model, "imageTag") === "IMG" ? "IMG" : undefined))).toBe("IMG");
		expect(variableValue(model, "image")).toEqual({
			__observablejs_type__: "element",
			value: "img",
		});
		expect((form as HTMLFormElement & { value: unknown }).value).toBeInstanceOf(Promise);
		await waitFor(() => (model.get("_has_rendered") === true ? true : undefined));
		expect((form as HTMLFormElement & { value: unknown }).value).toBeInstanceOf(Promise);
		expect(variableValue(model, "imageTag")).toBe("IMG");
		controller.abort();
	});

	test("keeps Python-owned view values while dependencies change", async () => {
		const model = createModel({
			role: "notebook",
			_spec: {
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
			_attachments: {},
			_variables: { seed: 1, gain: 5 },
			_options: {},
			_cell_widgets: ["anywidget:gain", "anywidget:seed-echo", "anywidget:doubled"],
		});
		const childModels = new Map([
			["anywidget:gain", createModel({ role: "cell", name: "gain", _values: {}, _value_names: [] })],
			["anywidget:seed-echo", createModel({ role: "cell", name: "seedEcho", _values: {}, _value_names: [] })],
			["anywidget:doubled", createModel({ role: "cell", name: "doubled", _values: {}, _value_names: [] })],
		]);
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render(renderProps(model, el, controller.signal, createHost(childModels)));

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
			_spec: {
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
			_attachments: {},
			_variables: { seed: 1 },
			_options: {},
			_cell_widgets: ["anywidget:gain", "anywidget:seed-echo", "anywidget:doubled"],
		});
		const childModels = new Map([
			["anywidget:gain", createModel({ role: "cell", name: "gain", _values: {}, _value_names: [] })],
			["anywidget:seed-echo", createModel({ role: "cell", name: "seedEcho", _values: {}, _value_names: [] })],
			["anywidget:doubled", createModel({ role: "cell", name: "doubled", _values: {}, _value_names: [] })],
		]);
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render(renderProps(model, el, controller.signal, createHost(childModels)));

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
			_spec: {
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
			_attachments: {},
			_variables: { seed: 1 },
			_options: {},
			_cell_widgets: ["anywidget:gain", "anywidget:doubled"],
		});
		const childModels = new Map([
			["anywidget:gain", createModel({ role: "cell", name: "gain", _values: {}, _value_names: [] })],
			["anywidget:doubled", createModel({ role: "cell", name: "doubled", _values: {}, _value_names: [] })],
		]);
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render(renderProps(model, el, controller.signal, createHost(childModels)));

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
			_spec: {
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
			_attachments: {},
			_variables: { seed: 1, gain: 5 },
			_options: {},
			_cell_widgets: ["anywidget:gain", "anywidget:doubled"],
		});
		const childModels = new Map([
			["anywidget:gain", createModel({ role: "cell", name: "gain", _values: {}, _value_names: [] })],
			["anywidget:doubled", createModel({ role: "cell", name: "doubled", _values: {}, _value_names: [] })],
		]);
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render(renderProps(model, el, controller.signal, createHost(childModels)));

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
});

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
