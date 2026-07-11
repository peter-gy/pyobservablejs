import { describe, expect, test, vi } from "vite-plus/test";
import {
	alertText,
	composedText,
	createHost,
	createModel,
	graphValue,
	renderProps,
	variableValue,
	waitFor,
	widget,
} from "./testing";

describe("NotebookCell projection", () => {
	test("renders the selected cell and its dependency closure through the parent widget", async () => {
		const parent = notebookModel([
			{ id: 1, mode: "ojs", value: "answer = 42" },
			{ id: 2, mode: "ojs", value: "double = answer * 2" },
		]);
		parent.set("_cell_keys", ["answer", "double"]);
		const cell = cellModel("anywidget:notebook", 1, "double");
		const host = createHost(new Map([["anywidget:notebook", parent]]));
		const controller = new AbortController();
		const el = document.createElement("div");

		widget.render(renderProps(cell, el, controller.signal, host));

		expect(await waitFor(() => composedText(el, "84"))).toBeInstanceOf(HTMLElement);
		expect(variableValue(parent, "double")).toBe(84);
		const graph = await waitFor(() => graphValue(parent));
		expect(graph.edges).toContainEqual({ from: 1, to: 2, variable: "answer" });
		expect(host.widgetLookups).toEqual(["anywidget:notebook"]);
		expect(host.modelLookups).toEqual([]);
		expect(host.renders).toHaveLength(1);
		expect(host.renders[0]?.el).toBe(el);
		expect(host.renders[0]?.signal.aborted).toBe(false);
		controller.abort();
		expect(host.renders[0]?.signal.aborted).toBe(true);
	});

	test("uses Python-owned values in projected dependencies", async () => {
		const source = vi.fn(() => 1);
		Object.defineProperty(globalThis, "__pyobservablejsProjectedSource", { configurable: true, value: source });
		const parent = notebookModel(
			[
				{ id: 1, mode: "ojs", value: "base = globalThis.__pyobservablejsProjectedSource()" },
				{ id: 2, mode: "ojs", value: "doubled = base * 2" },
			],
			{ base: 5 },
		);
		parent.set("_cell_keys", ["base", "doubled"]);
		const cell = cellModel("anywidget:notebook", 1, "doubled");
		const controller = new AbortController();
		try {
			widget.render(
				renderProps(
					cell,
					document.createElement("div"),
					controller.signal,
					createHost(new Map([["anywidget:notebook", parent]])),
				),
			);
			expect(await waitFor(() => (variableValue(parent, "doubled") === 10 ? 10 : undefined))).toBe(10);
			expect(source).not.toHaveBeenCalled();
		} finally {
			controller.abort();
			Reflect.deleteProperty(globalThis, "__pyobservablejsProjectedSource");
		}
	});

	test("does not evaluate unrelated cells outside the projected dependency closure", async () => {
		const unrelated = vi.fn(() => "unused");
		Object.defineProperty(globalThis, "__pyobservablejsUnrelatedCell", { configurable: true, value: unrelated });
		const parent = notebookModel([
			{ id: 1, mode: "ojs", value: "answer = 42" },
			{ id: 2, mode: "ojs", value: "unrelated = globalThis.__pyobservablejsUnrelatedCell()" },
			{ id: 3, mode: "ojs", value: "double = answer * 2" },
		]);
		parent.set("_cell_keys", ["answer", "unrelated", "double"]);
		const cell = cellModel("anywidget:notebook", 2, "double");
		const controller = new AbortController();
		const el = document.createElement("div");
		try {
			widget.render(renderProps(cell, el, controller.signal, createHost(new Map([["anywidget:notebook", parent]]))));
			expect(await waitFor(() => composedText(el, "84"))).toBeInstanceOf(HTMLElement);
			expect(unrelated).not.toHaveBeenCalled();
		} finally {
			controller.abort();
			Reflect.deleteProperty(globalThis, "__pyobservablejsUnrelatedCell");
		}
	});

	test("reports missing parent references and invalid cell indexes", async () => {
		const missingParent = createModel({ role: "cell", name: "answer" });
		const parent = notebookModel([{ id: 1, mode: "ojs", value: "answer = 42" }]);
		const invalidIndex = cellModel("anywidget:notebook", 9, "answer");
		const missingEl = document.createElement("div");
		const invalidEl = document.createElement("div");
		const missingController = new AbortController();
		const invalidController = new AbortController();

		widget.render(renderProps(missingParent, missingEl, missingController.signal));
		widget.render(
			renderProps(
				invalidIndex,
				invalidEl,
				invalidController.signal,
				createHost(new Map([["anywidget:notebook", parent]])),
			),
		);

		expect(await waitFor(() => alertText(missingEl))).toBe("Error: NotebookCell has no parent Notebook reference");
		expect(await waitFor(() => alertText(invalidEl))).toBe(
			"Error: NotebookCell index 9 is outside the parent Notebook",
		);
		missingController.abort();
		invalidController.abort();
	});

	test("reports parent references that resolve to a non-Notebook widget", async () => {
		const parent = createModel({});
		const cell = cellModel("anywidget:parent", 0, "answer");
		const controller = new AbortController();
		const el = document.createElement("div");

		widget.render(renderProps(cell, el, controller.signal, createHost(new Map([["anywidget:parent", parent]]))));

		expect(await waitFor(() => alertText(el))).toBe(
			"Error: NotebookCell parent reference does not resolve to a Notebook",
		);
		controller.abort();
	});

	test("a newer parent reference wins over a pending host lookup", async () => {
		let resolveSlow!: (model: ReturnType<typeof createModel>) => void;
		const slow = new Promise<ReturnType<typeof createModel>>((resolve) => {
			resolveSlow = resolve;
		});
		const fastParent = notebookModel([{ id: 1, mode: "ojs", value: "answer = 7" }]);
		fastParent.set("_cell_keys", ["answer"]);
		const slowParent = notebookModel([{ id: 1, mode: "ojs", value: "answer = 99" }]);
		slowParent.set("_cell_keys", ["answer"]);
		const cell = cellModel("anywidget:slow", 0, "answer");
		const host = createHost(
			new Map<string, ReturnType<typeof createModel> | Promise<ReturnType<typeof createModel>>>([
				["anywidget:slow", slow],
				["anywidget:fast", fastParent],
			]),
		);
		const controller = new AbortController();
		const el = document.createElement("div");
		widget.render(renderProps(cell, el, controller.signal, host));

		cell.set("_notebook_widget", "anywidget:fast");
		expect(await waitFor(() => composedText(el, "7"))).toBeInstanceOf(HTMLElement);
		resolveSlow(slowParent);
		await waitFor(() => (host.widgetResolutions.includes("anywidget:slow") ? true : undefined));

		expect(composedText(el, "7")).toBeInstanceOf(HTMLElement);
		expect(variableValue(fastParent, "answer")).toBe(7);
		expect(variableValue(slowParent, "answer")).toBeUndefined();
		controller.abort();
	});

	test("a failed direct view preserves readback from a live full Notebook view", async () => {
		const parent = notebookModel([{ id: 1, mode: "ojs", value: "answer = 42" }]);
		parent.set("_cell_keys", ["answer"]);
		const cell = cellModel("anywidget:notebook", 99, "answer");
		const host = createHost(new Map([["anywidget:notebook", parent]]));
		const fullController = new AbortController();
		const directController = new AbortController();
		const fullEl = document.createElement("div");
		const directEl = document.createElement("div");

		widget.render(renderProps(parent, fullEl, fullController.signal, host));
		await waitFor(() => (variableValue(parent, "answer") === 42 ? 42 : undefined));
		const graph = await waitFor(() => graphValue(parent));
		widget.render(renderProps(cell, directEl, directController.signal, host));

		expect(await waitFor(() => alertText(directEl))).toBe(
			"Error: NotebookCell index 99 is outside the parent Notebook",
		);
		expect(variableValue(parent, "answer")).toBe(42);
		expect(graphValue(parent)).toEqual(graph);
		expect(parent.get("_has_rendered")).toBe(true);
		directController.abort();
		fullController.abort();
	});

	test("aborting a projected view leaves the full Notebook view reactive", async () => {
		const parent = notebookModel([{ id: 1, mode: "ojs", value: "doubled = base * 2" }], { base: 2 });
		parent.set("_cell_keys", ["doubled"]);
		const cell = cellModel("anywidget:notebook", 0, "doubled");
		const host = createHost(new Map([["anywidget:notebook", parent]]));
		const fullController = new AbortController();
		const directController = new AbortController();
		widget.render(renderProps(parent, document.createElement("div"), fullController.signal, host));
		widget.render(renderProps(cell, document.createElement("div"), directController.signal, host));
		await waitFor(() => (variableValue(parent, "doubled") === 4 ? 4 : undefined));

		directController.abort();
		setVariables(parent, 1, { base: 5 });

		expect(await waitFor(() => (variableValue(parent, "doubled") === 10 ? 10 : undefined))).toBe(10);
		fullController.abort();
	});

	test("supports legacy Observable require in full Notebook rendering", async () => {
		const parent = notebookModel(
			[
				{ id: 1, mode: "ojs", value: `module = require("${moduleUrl("export const line = 'ready';")}")` },
				{ id: 2, mode: "ojs", value: "module.line" },
			],
			{},
		);
		parent.set("_options", { runtime_compatibility: { require: true } });
		parent.set("_cell_keys", ["module", "readout"]);
		const controller = new AbortController();
		widget.render(renderProps(parent, document.createElement("div"), controller.signal));

		expect(await waitFor(() => (variableValue(parent, "readout") === "ready" ? "ready" : undefined))).toBe("ready");
		controller.abort();
	});
});

function notebookModel(cells: Record<string, unknown>[], variables: Record<string, unknown> = {}) {
	return createModel({
		role: "notebook",
		_spec: { cells },
		_attachments: {},
		_variables: variables,
		_options: {},
	});
}

function cellModel(parentRef: string, index: number, name: string) {
	return createModel({
		role: "cell",
		key: name,
		name,
		_notebook_widget: parentRef,
		_notebook_index: index,
	});
}

function setVariables(model: ReturnType<typeof createModel>, seq: number, values: Record<string, unknown>): void {
	model.set("_variable_update", { seq, kind: "set", values });
	const previous = model.get("_variables");
	model.set("_variables", previous && typeof previous === "object" ? { ...previous, ...values } : values);
}

function moduleUrl(source: string): string {
	return `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
}
