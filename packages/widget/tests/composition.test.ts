import { toNotebook } from "@observablehq/notebook-kit";
import { describe, expect, test, vi } from "vite-plus/test";
import { analyzeNotebook, createRuntime, createRuntimeCleanup, registerAttachments } from "@pyobservablejs/runtime";
import widget from "../src";
import { renderStandaloneCellProjection, resolveCellModel } from "../src/composition";
import {
	alertText,
	composedText,
	createHost,
	createModel,
	graphValue,
	renderProps,
	variableValue,
	waitFor,
} from "./testing";

describe("notebook cell coordination", () => {
	test("renders direct cell displays from the explicit parent notebook reference", async () => {
		const parentModel = createModel({
			role: "notebook",
			_spec: {
				cells: [
					{ id: 1, mode: "ojs", value: "answer = 42", key: "answer" },
					{ id: 2, mode: "ojs", value: "double = answer * 2", key: "double" },
				],
			},
			_attachments: {},
			_variables: {},
			_options: {},
			_cell_keys: ["answer", "double"],
			_cell_widgets: ["anywidget:answer", "anywidget:double"],
		});
		const model = createModel({
			role: "cell",
			key: "double",
			name: "double",
			_notebook_widget: "anywidget:notebook",
			_notebook_index: 1,
			_values: {},
			_value_names: [],
		});
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render(
			renderProps(model, el, controller.signal, createHost(new Map([["anywidget:notebook", parentModel]]))),
		);

		await waitStep("standalone dependency output", () => composedText(el, "84"));
		expect(variableValue(model, "double")).toBe(84);
		const graph = await waitFor(() => graphValue(parentModel));
		expect(graph.cells.map((cell) => cell.key)).toEqual(["answer", "double"]);
		expect(graph.cells[1]?.key).toBe("double");
		expect(graph.cells[1]?.references).toEqual(["answer"]);
		expect(graph.edges).toContainEqual({ from: 1, to: 2, variable: "answer" });
		expect(model.get("_has_rendered")).toBe(true);
		expect(parentModel.get("_has_rendered")).toBeUndefined();
		controller.abort();
	});

	test("uses Python-owned values in direct cell dependencies", async () => {
		const trackSource = vi.fn(() => 1);
		Object.defineProperty(globalThis, "__pyobservablejsTrackPythonDependency", {
			configurable: true,
			value: trackSource,
		});
		const notebook = toNotebook({
			cells: [
				{
					id: 1,
					mode: "ojs",
					value: "base = globalThis.__pyobservablejsTrackPythonDependency()",
				},
				{ id: 2, mode: "ojs", value: "doubled = base * 2" },
			],
		});
		const parentModel = createModel({
			role: "notebook",
			_cell_keys: ["base", "doubled"],
		});
		const model = createModel({
			role: "cell",
			key: "doubled",
			name: "doubled",
			_values: {},
			_value_names: [],
		});
		const el = document.createElement("div");
		const root = document.createElement("div");
		el.appendChild(root);
		const controller = new AbortController();
		const options = {
			attachments: {},
			baseUrl: document.baseURI,
			variables: { base: 5 },
			showSource: false,
		};
		const registry = registerAttachments({});
		const runtime = createRuntime(root, el, options, registry);

		try {
			renderStandaloneCellProjection({
				parentModel,
				cellModel: model,
				root,
				notebook,
				cellIndex: 1,
				analysis: analyzeNotebook(notebook),
				runtime,
				options,
				variablesSync: {
					applyInitialViews() {},
					setView() {},
					deleteView() {},
				},
				signal: controller.signal,
			});

			await waitStep("Python-owned dependency output", () => composedText(el, "10"));
			expect(variableValue(model, "doubled")).toBe(10);
			expect(trackSource).not.toHaveBeenCalled();
		} finally {
			controller.abort();
			createRuntimeCleanup(runtime, registry)();
			Reflect.deleteProperty(globalThis, "__pyobservablejsTrackPythonDependency");
		}
	});

	test("applies Python values to hidden direct view dependencies", async () => {
		const parentModel = createModel({
			role: "notebook",
			_spec: {
				cells: [
					{
						id: 1,
						mode: "ojs",
						value: 'viewof gain = Object.assign(document.createElement("input"), {type: "range", value: 2})',
						key: "gain",
					},
					{ id: 2, mode: "ojs", value: "doubled = gain * 2", key: "doubled" },
				],
			},
			_attachments: {},
			_variables: { gain: 5 },
			_options: {},
			_cell_keys: ["gain", "doubled"],
			_cell_widgets: ["anywidget:gain", "anywidget:doubled"],
		});
		const model = createModel({
			role: "cell",
			key: "doubled",
			name: "doubled",
			_notebook_widget: "anywidget:notebook",
			_notebook_index: 1,
			_values: {},
			_value_names: [],
		});
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render(
			renderProps(model, el, controller.signal, createHost(new Map([["anywidget:notebook", parentModel]]))),
		);

		expect(
			await waitStep("Python-updated hidden view dependency", () =>
				variableValue(model, "doubled") === 10 ? 10 : undefined,
			),
		).toBe(10);
		controller.abort();
	});

	test("evaluates visibility inputs in hidden direct cell dependencies", async () => {
		class NeverVisibleObserver {
			observe(): void {}
			disconnect(): void {}
		}
		vi.stubGlobal("IntersectionObserver", NeverVisibleObserver);
		const parentModel = createModel({
			role: "notebook",
			_spec: {
				cells: [
					{ id: 1, mode: "ojs", value: "answer = visibility(42)", key: "answer" },
					{ id: 2, mode: "ojs", value: "doubled = answer * 2", key: "doubled" },
				],
			},
			_attachments: {},
			_variables: {},
			_options: {},
			_cell_keys: ["answer", "doubled"],
			_cell_widgets: ["anywidget:answer", "anywidget:doubled"],
		});
		const model = createModel({
			role: "cell",
			key: "doubled",
			name: "doubled",
			_notebook_widget: "anywidget:notebook",
			_notebook_index: 1,
			_values: {},
			_value_names: [],
		});
		const el = document.createElement("div");
		const controller = new AbortController();

		try {
			widget.render(
				renderProps(model, el, controller.signal, createHost(new Map([["anywidget:notebook", parentModel]]))),
			);

			await waitStep("visibility dependency output", () => composedText(el, "84"));
			expect(variableValue(model, "doubled")).toBe(84);
		} finally {
			controller.abort();
			vi.unstubAllGlobals();
		}
	});

	test("direct cell displays skip unrelated cells outside the dependency closure", async () => {
		const trackUnrelated = vi.fn();
		Object.defineProperty(globalThis, "__pyobservablejsTrackUnrelated", {
			configurable: true,
			value: trackUnrelated,
		});
		const parentModel = createModel({
			role: "notebook",
			_spec: {
				cells: [
					{ id: 1, mode: "ojs", value: "answer = 42", key: "answer" },
					{
						id: 2,
						mode: "ojs",
						value: "unrelated = globalThis.__pyobservablejsTrackUnrelated()",
						key: "unrelated",
					},
					{ id: 3, mode: "ojs", value: "double = answer * 2", key: "double" },
				],
			},
			_attachments: {},
			_variables: {},
			_options: {},
			_cell_keys: ["answer", "unrelated", "double"],
			_cell_widgets: ["anywidget:answer", "anywidget:unrelated", "anywidget:double"],
		});
		const model = createModel({
			role: "cell",
			key: "double",
			name: "double",
			_notebook_widget: "anywidget:notebook",
			_notebook_index: 2,
			_values: {},
			_value_names: [],
		});
		const el = document.createElement("div");
		const controller = new AbortController();

		try {
			widget.render(
				renderProps(model, el, controller.signal, createHost(new Map([["anywidget:notebook", parentModel]]))),
			);

			await waitStep("standalone closure output", () => composedText(el, "84"));
			expect(variableValue(model, "double")).toBe(84);
			const graph = await waitFor(() => graphValue(parentModel));
			await waitFor(() => (model.get("_has_rendered") === true ? true : undefined));
			expect(trackUnrelated).not.toHaveBeenCalled();
			expect(graph.cells.map((cell) => cell.key)).toEqual(["answer", "unrelated", "double"]);
			expect(model.get("_has_rendered")).toBe(true);
			expect(parentModel.get("_has_rendered")).toBeUndefined();
		} finally {
			controller.abort();
			Reflect.deleteProperty(globalThis, "__pyobservablejsTrackUnrelated");
		}
	});

	test("failed direct cell rerenders preserve the last successful shared readback", async () => {
		const parentModel = createModel({
			role: "notebook",
			_spec: {
				cells: [
					{ id: 1, mode: "ojs", value: "answer = 42", key: "answer" },
					{ id: 2, mode: "ojs", value: "double = answer * 2", key: "double" },
				],
			},
			_attachments: {},
			_variables: {},
			_options: {},
			_cell_keys: ["answer", "double"],
			_cell_widgets: ["anywidget:answer", "anywidget:double"],
		});
		const model = createModel({
			role: "cell",
			key: "double",
			name: "double",
			_notebook_widget: "anywidget:notebook",
			_notebook_index: 1,
			_values: {},
			_value_names: [],
		});
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render(
			renderProps(model, el, controller.signal, createHost(new Map([["anywidget:notebook", parentModel]]))),
		);

		await waitStep("initial direct output", () => composedText(el, "84"));
		expect(variableValue(model, "double")).toBe(84);
		expect(model.get("_has_rendered")).toBe(true);

		model.set("_notebook_index", 99);

		expect(await waitFor(() => projectErrorText(el))).toBe(
			"Error: NotebookCell index 99 is outside the parent Notebook",
		);
		expect(model.get("_has_rendered")).toBe(true);
		expect(variableValue(model, "double")).toBe(84);
		controller.abort();
	});

	test("successful direct cell rerenders replace old value names", async () => {
		const parentModel = createModel({
			role: "notebook",
			_spec: {
				cells: [
					{ id: 1, mode: "ojs", value: "answer = 42", key: "answer" },
					{ id: 2, mode: "ojs", value: "double = answer * 2", key: "double" },
				],
			},
			_attachments: {},
			_variables: {},
			_options: {},
			_cell_keys: ["answer", "double"],
			_cell_widgets: ["anywidget:answer", "anywidget:double"],
		});
		const model = createModel({
			role: "cell",
			key: "answer",
			name: "answer",
			_notebook_widget: "anywidget:notebook",
			_notebook_index: 0,
			_values: {},
			_value_names: [],
		});
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render(
			renderProps(model, el, controller.signal, createHost(new Map([["anywidget:notebook", parentModel]]))),
		);

		await waitStep("initial direct value", () => composedText(el, "42"));
		expect(variableValue(model, "answer")).toBe(42);

		model.set("_notebook_index", 1);

		await waitStep("rerendered direct value", () => composedText(el, "84"));
		expect(variableValue(model, "answer")).toBeUndefined();
		expect(variableValue(model, "double")).toBe(84);
		expect(model.get("_value_names")).toEqual(["double"]);
		controller.abort();
	});

	test("multi-output cells become rendered only after every output syncs", async () => {
		const cellModel = createModel({
			role: "cell",
			key: "metrics",
			name: "metrics",
			_values: {},
			_value_names: [],
		});
		const model = createModel({
			role: "notebook",
			_spec: {
				cells: [
					{
						id: 1,
						mode: "js",
						value: "const x = 1;\nconst y = new Promise((resolve) => setTimeout(() => resolve(2), 100));",
						key: "metrics",
					},
				],
			},
			_attachments: {},
			_variables: {},
			_options: {},
			_cell_keys: ["metrics"],
			_cell_widgets: ["anywidget:metrics"],
		});
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render(renderProps(model, el, controller.signal, createHost(new Map([["anywidget:metrics", cellModel]]))));

		expect(await waitFor(() => (variableValue(cellModel, "x") === 1 ? 1 : undefined))).toBe(1);
		expect(cellModel.get("_has_rendered")).toBe(false);
		expect(model.get("_has_rendered")).toBe(false);
		expect(variableValue(cellModel, "y")).toBeUndefined();
		expect(await waitFor(() => (variableValue(cellModel, "y") === 2 ? 2 : undefined), 1500)).toBe(2);
		expect(await waitFor(() => (cellModel.get("_has_rendered") === true ? true : undefined))).toBe(true);
		expect(await waitFor(() => (model.get("_has_rendered") === true ? true : undefined))).toBe(true);
		controller.abort();
	});

	test("reports direct cell displays without a parent notebook reference", async () => {
		const model = createModel({
			role: "cell",
			name: "answer",
			_values: {},
			_value_names: [],
		});
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render(renderProps(model, el, controller.signal, createHost(new Map())));

		expect(await waitFor(() => projectErrorText(el))).toBe("Error: NotebookCell has no parent Notebook reference");
		controller.abort();
	});

	test("aborts pending host model lookups", async () => {
		const controller = new AbortController();
		const pending = new Promise<ReturnType<typeof createModel>>(() => {});
		const host = createHost(new Map([["anywidget:pending", pending]]));
		const outcome = resolveCellModel(host, "anywidget:pending", controller.signal);

		controller.abort();

		await expect(outcome).rejects.toThrow("Unable to resolve cell widget anywidget:pending");
	});

	test("reports direct cell displays whose parent ref does not point to a notebook", async () => {
		const parentModel = createModel({
			_spec: { cells: [{ id: 1, mode: "ojs", value: "answer = 42" }] },
			_attachments: {},
			_variables: {},
			_options: {},
		});
		const model = createModel({
			role: "cell",
			name: "answer",
			_notebook_widget: "anywidget:parent",
			_notebook_index: 0,
			_values: {},
			_value_names: [],
		});
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render(renderProps(model, el, controller.signal, createHost(new Map([["anywidget:parent", parentModel]]))));

		expect(await waitFor(() => projectErrorText(el))).toBe("Error: Parent widget anywidget:parent is not a Notebook");
		controller.abort();
	});

	test("failed notebook rerenders clear stale notebook readback", async () => {
		const answerModel = createModel({
			role: "cell",
			key: "answer",
			name: "answer",
			_values: {},
			_value_names: [],
		});
		const model = createModel({
			role: "notebook",
			_spec: { cells: [{ id: 1, mode: "ojs", value: "answer = 42", key: "answer" }] },
			_attachments: {},
			_variables: {},
			_options: {},
			_cell_keys: ["answer"],
			_cell_widgets: ["anywidget:answer"],
		});
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render(renderProps(model, el, controller.signal, createHost(new Map([["anywidget:answer", answerModel]]))));

		await waitStep("initial notebook output", () => composedText(el, "42"));
		expect(await waitFor(() => (variableValue(model, "answer") === 42 ? 42 : undefined))).toBe(42);
		expect(model.get("_has_rendered")).toBe(true);

		model.set("_spec", {
			cells: [
				{ id: 1, mode: "ojs", value: "answer = 42", key: "answer" },
				{ id: 2, mode: "ojs", value: "double = answer * 2", key: "double" },
			],
		});

		expect(await waitFor(() => projectErrorText(el))).toBe("Error: Expected 2 cell widgets, received 1");
		expect(model.get("_has_rendered")).toBe(false);
		expect(variableValue(model, "answer")).toBeUndefined();
		expect(model.get("_graph")).toEqual({});
		expect(answerModel.get("_has_rendered")).toBe(false);
		expect(variableValue(answerModel, "answer")).toBeUndefined();
		controller.abort();
	});

	test("renders source notebooks that use legacy Observable require", async () => {
		const model = createModel({
			role: "notebook",
			_spec: {
				cells: [
					{ id: 1, mode: "ojs", value: `geometric = require("${moduleUrl("export const line = 'ready';")}")` },
					{ id: 2, mode: "ojs", value: `geometric.line` },
				],
			},
			_attachments: {},
			_variables: {},
			_options: { runtime_compatibility: { require: true } },
			_cell_widgets: ["anywidget:geometric", "anywidget:readout"],
		});
		const geometricModel = createModel({
			role: "cell",
			name: "geometric",
			_values: {},
			_value_names: [],
		});
		const readoutModel = createModel({
			role: "cell",
			name: "readout",
			_values: {},
			_value_names: [],
		});
		const controller = new AbortController();
		const el = document.createElement("div");

		widget.render(
			renderProps(
				model,
				el,
				controller.signal,
				createHost(
					new Map([
						["anywidget:geometric", geometricModel],
						["anywidget:readout", readoutModel],
					]),
				),
			),
		);

		await waitStep("require readout", () => (variableValue(readoutModel, "readout") === "ready" ? "ready" : undefined));
		expect(variableValue(geometricModel, "geometric")).toMatchObject({ line: "ready" });
		expect(readoutModel.get("_has_rendered")).toBe(true);
		const graph = await waitFor(() => graphValue(model));
		expect(graph.edges).toContainEqual({ from: 1, to: 2, variable: "geometric" });
		expect(await waitFor(() => (model.get("_has_rendered") === true ? true : undefined))).toBe(true);
		expect(projectErrorText(el)).toBeUndefined();
		controller.abort();
	});

	test("renders inspector failures as display fallbacks without blocking readback", async () => {
		const unsafeModel = createModel({
			role: "cell",
			name: "unsafe",
			_values: {},
			_value_names: [],
		});
		const model = createModel({
			role: "notebook",
			_spec: {
				cells: [
					{
						id: 1,
						mode: "ojs",
						value: `unsafe = {
							const value = { ok: true };
							Object.defineProperty(value, "constructor", {
								get() { throw new TypeError("inspector failed"); }
							});
							return value;
						}`,
					},
				],
			},
			_attachments: {},
			_variables: {},
			_options: {},
			_cell_widgets: ["anywidget:unsafe"],
		});
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render(renderProps(model, el, controller.signal, createHost(new Map([["anywidget:unsafe", unsafeModel]]))));

		await waitStep("inspector fallback", () =>
			composedText(el, "Unable to inspect value: TypeError: inspector failed"),
		);
		expect(projectErrorText(el)).toBeUndefined();
		expect(variableValue(unsafeModel, "unsafe")).toEqual({ ok: true });
		expect(await waitFor(() => (unsafeModel.get("_has_rendered") === true ? true : undefined))).toBe(true);
		expect(await waitFor(() => (model.get("_has_rendered") === true ? true : undefined))).toBe(true);
		controller.abort();
	});

	test("full notebook render completes with display-only cells that have no readback names", async () => {
		const displayModel = createModel({
			role: "cell",
			name: "",
			_values: {},
			_value_names: [],
		});
		const answerModel = createModel({
			role: "cell",
			key: "answer",
			name: "answer",
			_values: {},
			_value_names: [],
		});
		const model = createModel({
			role: "notebook",
			_spec: {
				cells: [
					{ id: 1, mode: "ojs", value: "md`Summary`" },
					{ id: 2, mode: "ojs", value: "answer = 42", key: "answer" },
				],
			},
			_attachments: {},
			_variables: {},
			_options: {},
			_cell_keys: ["", "answer"],
			_cell_widgets: ["anywidget:summary", "anywidget:answer"],
		});
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render(
			renderProps(
				model,
				el,
				controller.signal,
				createHost(
					new Map([
						["anywidget:summary", displayModel],
						["anywidget:answer", answerModel],
					]),
				),
			),
		);

		await waitStep("display-only output", () => composedText(el, "Summary"));
		expect(await waitFor(() => (variableValue(model, "answer") === 42 ? 42 : undefined))).toBe(42);
		expect(await waitFor(() => (model.get("_has_rendered") === true ? true : undefined))).toBe(true);
		expect(displayModel.get("_has_rendered")).toBe(true);
		expect(answerModel.get("_has_rendered")).toBe(true);
		controller.abort();
	});

	test("failed direct cell display preserves parent notebook readback", async () => {
		const answerModel = createModel({
			role: "cell",
			key: "answer",
			name: "answer",
			_notebook_widget: "anywidget:notebook",
			_notebook_index: 99,
			_values: {},
			_value_names: [],
		});
		const model = createModel({
			role: "notebook",
			_spec: { cells: [{ id: 1, mode: "ojs", value: "answer = 42", key: "answer" }] },
			_attachments: {},
			_variables: {},
			_options: {},
			_cell_keys: ["answer"],
			_cell_widgets: ["anywidget:answer"],
		});
		const parentEl = document.createElement("div");
		const directEl = document.createElement("div");
		const parentController = new AbortController();
		const directController = new AbortController();
		const host = createHost(
			new Map([
				["anywidget:notebook", model],
				["anywidget:answer", answerModel],
			]),
		);

		widget.render(renderProps(model, parentEl, parentController.signal, host));

		await waitStep("parent output", () => composedText(parentEl, "42"));
		expect(await waitFor(() => (model.get("_has_rendered") === true ? true : undefined))).toBe(true);
		expect(variableValue(model, "answer")).toBe(42);
		const graph = await waitFor(() => graphValue(model));

		widget.render(renderProps(answerModel, directEl, directController.signal, host));

		expect(await waitFor(() => projectErrorText(directEl))).toBe(
			"Error: NotebookCell index 99 is outside the parent Notebook",
		);
		expect(model.get("_has_rendered")).toBe(true);
		expect(variableValue(model, "answer")).toBe(42);
		expect(graphValue(model)).toEqual(graph);
		expect(answerModel.get("_has_rendered")).toBe(true);
		expect(variableValue(answerModel, "answer")).toBe(42);
		directController.abort();
		parentController.abort();
	});

	test("transpile errors render as completed cell outputs", async () => {
		const brokenModel = createModel({
			role: "cell",
			key: "broken",
			name: "broken",
			_values: {},
			_value_names: [],
		});
		const model = createModel({
			role: "notebook",
			_spec: { cells: [{ id: 1, mode: "ojs", value: "broken =", key: "broken" }] },
			_attachments: {},
			_variables: {},
			_options: {},
			_cell_keys: ["broken"],
			_cell_widgets: ["anywidget:broken"],
		});
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render(renderProps(model, el, controller.signal, createHost(new Map([["anywidget:broken", brokenModel]]))));

		expect(await waitFor(() => projectErrorText(el))).toContain("SyntaxError");
		expect(await waitFor(() => (brokenModel.get("_has_rendered") === true ? true : undefined))).toBe(true);
		expect(await waitFor(() => (model.get("_has_rendered") === true ? true : undefined))).toBe(true);
		expect(variableValue(model, "broken")).toBeUndefined();
		controller.abort();
	});

	test("renders cell output from models resolved by the anywidget host", async () => {
		const childModel = createModel({
			role: "cell",
			name: "answer",
			_values: {},
			_value_names: [],
		});
		const model = createModel({
			role: "notebook",
			_spec: { cells: [{ id: 1, mode: "ojs", value: "answer = 42" }] },
			_attachments: {},
			_variables: {},
			_options: {},
			_cell_widgets: ["anywidget:answer"],
		});
		const host = createHost(new Map([["anywidget:answer", childModel]]));
		let lookups = 0;
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render(
			renderProps(model, el, controller.signal, {
				...host,
				async getModel(ref) {
					lookups += 1;
					return host.getModel(ref);
				},
			}),
		);

		await waitStep("composed output", () => composedText(el, "42"));
		expect(lookups).toBe(1);
		controller.abort();
	});

	test("renders pinned source chrome for cell output", async () => {
		const source = "answer = 42";
		const answerModel = createModel({
			role: "cell",
			name: "answer",
			_values: {},
			_value_names: [],
		});
		const model = createModel({
			role: "notebook",
			_spec: { cells: [{ id: 1, mode: "ojs", value: source, pinned: true }] },
			_attachments: {},
			_variables: {},
			_options: { show_source: true },
			_cell_widgets: ["anywidget:answer"],
		});
		const childModels = new Map([["anywidget:answer", answerModel]]);
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render(renderProps(model, el, controller.signal, createHost(childModels)));

		await waitStep("pinned source output", () => (variableValue(answerModel, "answer") === 42 ? 42 : undefined));
		const sourceBlock = await waitFor(
			() => el.querySelector<HTMLPreElement>("pre[aria-label='OJS source']") ?? undefined,
		);

		expect(sourceBlock.textContent).toBe(source);
		expect(sourceBlock.getAttribute("aria-label")).toBe("OJS source");
		controller.abort();
	});

	test("reports unresolved child models without blocking resolved value sync", async () => {
		const answerModel = createModel({
			role: "cell",
			name: "answer",
			_values: {},
			_value_names: [],
		});
		const model = createModel({
			role: "notebook",
			_spec: {
				cells: [
					{ id: 1, mode: "ojs", value: "answer = 42" },
					{ id: 2, mode: "ojs", value: "broken = answer + 1" },
				],
			},
			_attachments: {},
			_variables: {},
			_options: {},
			_cell_widgets: ["anywidget:answer", "anywidget:broken"],
		});
		const childModels = new Map([["anywidget:answer", answerModel]]);
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render(renderProps(model, el, controller.signal, createHost(childModels)));

		await waitStep("resolved cell output", () => composedText(el, "42"));
		expect(variableValue(answerModel, "answer")).toBe(42);
		expect(await waitFor(() => (variableValue(model, "answer") === 42 ? 42 : undefined))).toBe(42);
		const graph = await waitFor(() => graphValue(model), 1500);
		expect(graph.cells[0]?.defines).toEqual(["answer"]);
		expect(graph.cells[1]?.defines).toEqual(["broken"]);
		expect(graph.edges).toContainEqual({ from: 1, to: 2, variable: "answer" });
		expect(await waitFor(() => projectErrorText(el), 1500)).toBe("Error: Unknown widget model anywidget:broken");
		controller.abort();
	});

	test("aborted render ignores later model changes", () => {
		const model = createModel({
			role: "notebook",
			_spec: { cells: [] },
			_attachments: {},
			_variables: {},
			_options: {},
			_cell_widgets: [],
		});
		const controller = new AbortController();
		controller.abort();
		const el = document.createElement("div");

		widget.render(renderProps(model, el, controller.signal, createHost(new Map())));

		model.set("_spec", {
			cells: [{ id: 1, mode: "ojs", value: "answer = 42" }],
		});
		model.set("_cell_widgets", ["anywidget:answer"]);
		expect(el.childElementCount).toBe(0);
	});
});

function moduleUrl(source: string): string {
	return `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
}

async function waitStep<T>(label: string, read: () => T | undefined, timeoutMs?: number): Promise<T> {
	try {
		return await waitFor(read, timeoutMs);
	} catch (error) {
		throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function projectErrorText(el: HTMLElement): string | undefined {
	return alertText(el);
}
