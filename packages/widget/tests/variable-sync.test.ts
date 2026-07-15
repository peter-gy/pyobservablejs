import { describe, expect, test } from "vite-plus/test";
import {
	composedText,
	createNotebookFixture,
	hasRendered,
	renderProps,
	setRange,
	setVariables,
	type TestModel,
	variableValue,
	waitFor,
	widget,
} from "./testing";

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

const seededGainCell = {
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
} as const;

describe("widget variable sync", () => {
	test("updates existing Python variables through the runtime", async () => {
		const { session, view, host } = createNotebookFixture({
			_spec: {
				cells: [
					{ id: 1, mode: "ojs", value: "base_echo = base" },
					{ id: 2, mode: "ojs", value: "doubled = base * 2" },
				],
			},
			_variables: { base: 2 },
		});
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render(renderProps(view, el, controller.signal, host));

		expect(await waitFor(() => (variableValue(view, "doubled") === 4 ? 4 : undefined))).toBe(4);
		await waitFor(() => composedText(el, "4"));

		setVariables(session, 1, "set", { base: 5 });

		expect(await waitFor(() => (variableValue(view, "doubled") === 10 ? 10 : undefined))).toBe(10);
		expect(variableValue(view, "base_echo")).toBe(5);
		await waitFor(() => composedText(el, "10"));
		controller.abort();
	});

	test("rejects live variables that collide with the selected runtime builtins", async () => {
		const { session, view, host } = createNotebookFixture({
			_spec: {
				cells: [{ id: 1, mode: "ojs", value: "answer = 42" }],
			},
			_runtime_profile: "observable",
		});
		const controller = new AbortController();

		widget.render(renderProps(view, document.createElement("div"), controller.signal, host));

		await waitFor(() => (variableValue(view, "answer") === 42 ? 42 : undefined));

		expect(() => setVariables(session, 1, "set", { require: "shadowed" })).toThrow(
			"Python variables cannot override Observable runtime builtins: require",
		);
		controller.abort();
	});

	test("keeps Python-owned hidden cells hidden", async () => {
		const { view, host } = createNotebookFixture({
			_spec: {
				cells: [{ id: 1, mode: "ojs", value: "answer = 1", hidden: true }],
			},
			_variables: { answer: 41 },
		});
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render(renderProps(view, el, controller.signal, host));

		expect(await waitFor(() => (variableValue(view, "answer") === 41 ? 41 : undefined))).toBe(41);
		expect(el.textContent.trim()).toBe("");
		controller.abort();
	});

	test("uses Python-owned outputs from mixed JS declarations", async () => {
		const { session, view, host } = createNotebookFixture({
			_spec: {
				cells: [
					{
						id: 1,
						mode: "js",
						value: 'const answer = 1; const label = "source label";',
					},
				],
			},
			_variables: { answer: 41 },
		});
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render(renderProps(view, el, controller.signal, host));

		expect(await waitFor(() => (variableValue(view, "answer") === 41 ? 41 : undefined))).toBe(41);
		expect(await waitFor(() => (variableValue(view, "label") === "source label" ? "source label" : undefined))).toBe(
			"source label",
		);
		expect(variableValue(view, "answer")).toBe(41);
		expect(variableValue(view, "label")).toBe("source label");

		setVariables(session, 1, "set", { answer: 43 });

		expect(await waitFor(() => (variableValue(view, "answer") === 43 ? 43 : undefined))).toBe(43);
		expect(variableValue(view, "label")).toBe("source label");
		controller.abort();
	});

	test("defines newly added Python variables through the runtime", async () => {
		const { session, view, host } = createNotebookFixture({
			_spec: {
				cells: [
					{ id: 1, mode: "ojs", value: "base_echo = base" },
					{ id: 2, mode: "ojs", value: "doubled = base * 2" },
				],
			},
		});
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render(renderProps(view, el, controller.signal, host));
		setVariables(session, 1, "set", { base: 6 });

		expect(await waitFor(() => (variableValue(view, "doubled") === 12 ? 12 : undefined))).toBe(12);
		expect(variableValue(view, "base_echo")).toBe(6);
		controller.abort();
	});

	test("restores source definitions when Python variable replacement removes keys", async () => {
		const { session, view, host } = createNotebookFixture({
			_spec: {
				cells: [
					{ id: 1, mode: "ojs", value: "base = 1" },
					{ id: 2, mode: "ojs", value: "doubled = base * 2" },
				],
			},
			_variables: { base: 5 },
		});
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render(renderProps(view, el, controller.signal, host));

		expect(await waitFor(() => (variableValue(view, "doubled") === 10 ? 10 : undefined))).toBe(10);

		setVariables(session, 1, "replace", {});

		expect(await waitFor(() => (variableValue(view, "doubled") === 2 ? 2 : undefined))).toBe(2);
		controller.abort();
	});

	test("routes unsupported view writes through runtime variables", async () => {
		const { view, host } = createNotebookFixture({
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
			_variables: { gain: { pointDensity: 21 } },
		});
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render(renderProps(view, el, controller.signal, host));

		await waitFor(() => rangeWithValue(el, 5));
		expect(await waitFor(() => (variableValue(view, "gainKind") === "object" ? "object" : undefined))).toBe("object");
		controller.abort();
	});

	test("updates object-valued viewof variables through nested selects", async () => {
		const { session, view, host } = createNotebookFixture({
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
		});
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render(renderProps(view, el, controller.signal, host));

		const select = await waitFor(() => onlySelect(el));
		expect(await waitFor(() => (variableValue(view, "pointDensity") === 7 ? 7 : undefined))).toBe(7);

		setVariables(session, 1, "set", { presets: { pointDensity: 21 } });

		await waitFor(() => (variableValue(view, "pointDensity") === 21 ? 21 : undefined));
		expect(select.selectedIndex).toBe(1);
		expect(select.closest("form")?.value).toEqual({ pointDensity: 21 });
		controller.abort();
	});

	test("keeps view controls unchanged for lossy element summaries", async () => {
		const { view, host } = createNotebookFixture({
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
		});
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render(renderProps(view, el, controller.signal, host));

		const form = await waitFor(() => el.querySelector("form") ?? undefined);
		expect(await waitFor(() => (variableValue(view, "imageTag") === "IMG" ? "IMG" : undefined))).toBe("IMG");
		expect(variableValue(view, "image")).toEqual({
			__observablejs_type__: "element",
			value: "img",
		});
		expect((form as HTMLFormElement & { value: unknown }).value).toBeInstanceOf(Promise);
		await waitFor(() => (hasRendered(view) ? true : undefined));
		expect((form as HTMLFormElement & { value: unknown }).value).toBeInstanceOf(Promise);
		expect(variableValue(view, "imageTag")).toBe("IMG");
		controller.abort();
	});

	test("keeps Python-owned view values while dependencies change", async () => {
		const { session, view, host } = createNotebookFixture({
			_spec: {
				cells: [
					seededGainCell,
					{ id: 2, mode: "ojs", value: "seedEcho = seed" },
					{ id: 3, mode: "ojs", value: "doubled = gain * 2" },
				],
			},
			_variables: { seed: 1, gain: 5 },
		});
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render(renderProps(view, el, controller.signal, host));

		await waitFor(() => rangeWithValue(el, 5));
		expect(await waitFor(() => (variableValue(view, "seedEcho") === 1 ? 1 : undefined))).toBe(1);

		setVariables(session, 1, "set", { seed: 2 });
		await waitFor(() => rangeWithValue(el, 5));
		expect(await waitFor(() => (variableValue(view, "seedEcho") === 2 ? 2 : undefined))).toBe(2);

		setVariables(session, 2, "set", { gain: 7 });

		await waitFor(() => rangeWithValue(el, 7));
		expect(await waitFor(() => (variableValue(view, "doubled") === 14 ? 14 : undefined))).toBe(14);
		controller.abort();
	});

	test("preserves user-set view values across repeated dependency replacements", async () => {
		const { session, view, host } = createNotebookFixture({
			_spec: {
				cells: [
					seededGainCell,
					{ id: 2, mode: "ojs", value: "seedEcho = seed" },
					{ id: 3, mode: "ojs", value: "doubled = gain * 2" },
				],
			},
			_variables: { seed: 1 },
		});
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render(renderProps(view, el, controller.signal, host));

		const firstInput = await waitFor(() => rangeWithValue(el, 1));
		expect(await waitFor(() => (variableValue(view, "seedEcho") === 1 ? 1 : undefined))).toBe(1);
		setRange(firstInput, 5);
		await waitFor(() => (variableValue(view, "gain") === 5 ? 5 : undefined));

		setVariables(session, 1, "set", { seed: 2 });
		await waitFor(() => rangeWithValue(el, 5));
		expect(await waitFor(() => (variableValue(view, "seedEcho") === 2 ? 2 : undefined))).toBe(2);

		setVariables(session, 2, "set", { seed: 3 });
		await waitFor(() => rangeWithValue(el, 5));
		expect(await waitFor(() => (variableValue(view, "seedEcho") === 3 ? 3 : undefined))).toBe(3);
		expect(await waitFor(() => (variableValue(view, "doubled") === 10 ? 10 : undefined))).toBe(10);
		controller.abort();
	});

	test("uses replacement view defaults until the user changes the view", async () => {
		const { session, view, host } = createNotebookFixture({
			_spec: {
				cells: [seededGainCell, { id: 2, mode: "ojs", value: "doubled = gain * 2" }],
			},
			_variables: { seed: 1 },
		});
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render(renderProps(view, el, controller.signal, host));

		await waitStep("initial view default", () => rangeWithValue(el, 1), view);
		expect(
			await waitStep("initial derived value", () => (variableValue(view, "doubled") === 2 ? 2 : undefined), view),
		).toBe(2);

		setVariables(session, 1, "set", { seed: 2 });
		await waitStep("first replacement default", () => rangeWithValue(el, 2), view);
		expect(
			await waitStep("first replacement value", () => (variableValue(view, "doubled") === 4 ? 4 : undefined), view),
		).toBe(4);

		setVariables(session, 2, "set", { seed: 3 });
		await waitStep("second replacement default", () => rangeWithValue(el, 3), view);
		expect(
			await waitStep("second replacement value", () => (variableValue(view, "doubled") === 6 ? 6 : undefined), view),
		).toBe(6);
		controller.abort();
	});

	test("uses view defaults after Python replacement removes a view value", async () => {
		const { session, view, host } = createNotebookFixture({
			_spec: {
				cells: [seededGainCell, { id: 2, mode: "ojs", value: "doubled = gain * 2" }],
			},
			_variables: { seed: 1, gain: 5 },
		});
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render(renderProps(view, el, controller.signal, host));

		const firstInput = await waitStep("Python-owned initial view", () => rangeWithValue(el, 5), view);
		expect(
			await waitStep(
				"Python-owned initial value",
				() => (variableValue(view, "doubled") === 10 ? 10 : undefined),
				view,
			),
		).toBe(10);
		setRange(firstInput, 6);
		await waitStep("interaction value", () => (variableValue(view, "doubled") === 12 ? 12 : undefined), view);

		setVariables(session, 1, "replace", { seed: 2 });
		await waitStep("replacement removes view override", () => rangeWithValue(el, 2), view);
		expect(
			await waitStep("replacement default value", () => (variableValue(view, "doubled") === 4 ? 4 : undefined), view),
		).toBe(4);

		setVariables(session, 2, "set", { seed: 3 });
		await waitStep("post-replacement view default", () => rangeWithValue(el, 3), view);
		expect(
			await waitStep("post-replacement value", () => (variableValue(view, "doubled") === 6 ? 6 : undefined), view),
		).toBe(6);
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

async function waitStep<T>(label: string, read: () => T | undefined, model: TestModel): Promise<T> {
	try {
		return await waitFor(read);
	} catch (error) {
		throw new Error(`${label}: ${String(error)}; readback=${JSON.stringify(model.get("_readback"))}`);
	}
}
