// @vitest-environment jsdom

import type { RenderProps } from "@anywidget/types";
import { describe, expect, test } from "vitest";
import widget from "@/widget/app";
import { SELECTORS } from "@/widget/dom";
import {
	composedInspectorText,
	composedText,
	createHost,
	createModel,
	graphValue,
	projectErrorText,
	variableValue,
	waitFor,
	waitStep,
} from "@/_tests/testing";
import type { WidgetModel } from "@/widget/state";

describe("widget composition lifecycle", () => {
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

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: createHost(new Map([["anywidget:notebook", parentModel]])),
		} as unknown as RenderProps<WidgetModel>);

		await waitStep("standalone dependency output", () => composedText(el, "84"));
		expect(el.querySelectorAll(SELECTORS.composedCell)).toHaveLength(1);
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

	test("direct cell displays skip unrelated cells outside the dependency closure", async () => {
		const parentModel = createModel({
			role: "notebook",
			_spec: {
				cells: [
					{ id: 1, mode: "ojs", value: "answer = 42", key: "answer" },
					{
						id: 2,
						mode: "ojs",
						value: 'unrelated = { throw new Error("unrelated cell ran"); }',
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

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: createHost(new Map([["anywidget:notebook", parentModel]])),
		} as unknown as RenderProps<WidgetModel>);

		await waitStep("standalone closure output", () => composedText(el, "84"));
		await new Promise((resolve) => window.setTimeout(resolve, 25));
		expect(projectErrorText(el)).toBeUndefined();
		expect(el.textContent).not.toContain("unrelated cell ran");
		expect(variableValue(model, "double")).toBe(84);
		const graph = await waitFor(() => graphValue(parentModel));
		expect(graph.cells.map((cell) => cell.key)).toEqual(["answer", "unrelated", "double"]);
		expect(model.get("_has_rendered")).toBe(true);
		expect(parentModel.get("_has_rendered")).toBeUndefined();
		controller.abort();
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

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: createHost(new Map([["anywidget:notebook", parentModel]])),
		} as unknown as RenderProps<WidgetModel>);

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

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: createHost(new Map([["anywidget:notebook", parentModel]])),
		} as unknown as RenderProps<WidgetModel>);

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

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: createHost(new Map([["anywidget:metrics", cellModel]])),
		} as unknown as RenderProps<WidgetModel>);

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

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: undefined,
		} as unknown as RenderProps<WidgetModel>);

		expect(await waitFor(() => projectErrorText(el))).toBe("Error: NotebookCell has no parent Notebook reference");
		controller.abort();
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

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: createHost(new Map([["anywidget:parent", parentModel]])),
		} as unknown as RenderProps<WidgetModel>);

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

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: createHost(new Map([["anywidget:answer", answerModel]])),
		} as unknown as RenderProps<WidgetModel>);

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
			_options: {},
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

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: createHost(
				new Map([
					["anywidget:geometric", geometricModel],
					["anywidget:readout", readoutModel],
				]),
			),
		} as unknown as RenderProps<WidgetModel>);

		await waitStep("require readout", () => composedInspectorText(el, "ready"));
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

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: createHost(new Map([["anywidget:unsafe", unsafeModel]])),
		} as unknown as RenderProps<WidgetModel>);

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

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: createHost(
				new Map([
					["anywidget:summary", displayModel],
					["anywidget:answer", answerModel],
				]),
			),
		} as unknown as RenderProps<WidgetModel>);

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

		widget.render({
			model,
			el: parentEl,
			signal: parentController.signal,
			host,
		} as unknown as RenderProps<WidgetModel>);

		await waitStep("parent output", () => composedText(parentEl, "42"));
		expect(await waitFor(() => (model.get("_has_rendered") === true ? true : undefined))).toBe(true);
		expect(variableValue(model, "answer")).toBe(42);
		const graph = await waitFor(() => graphValue(model));

		widget.render({
			model: answerModel,
			el: directEl,
			signal: directController.signal,
			host,
		} as unknown as RenderProps<WidgetModel>);

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

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: createHost(new Map([["anywidget:broken", brokenModel]])),
		} as unknown as RenderProps<WidgetModel>);

		expect(await waitFor(() => projectErrorText(el))).toContain("Error:");
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
		const childModels = new Map([["anywidget:answer", childModel]]);
		let lookupAttempts = 0;
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: {
				getModel: async (ref: string) => {
					lookupAttempts += 1;
					await new Promise((resolve) => window.setTimeout(resolve, 0));
					return lookupAttempts >= 3 ? childModels.get(ref) : undefined;
				},
				getWidget: async () => {
					throw new Error("Test host resolves child models only");
				},
			},
		} as unknown as RenderProps<WidgetModel>);

		await waitStep("composed output", () => composedText(el, "42"));
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

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: createHost(childModels),
		} as unknown as RenderProps<WidgetModel>);

		const wrapper = await waitFor(() => el.querySelector<HTMLElement>(SELECTORS.composedCell) ?? undefined);
		await waitStep("pinned source output", () => (variableValue(answerModel, "answer") === 42 ? 42 : undefined));
		const sourceBlock = await waitFor(
			() => wrapper.querySelector<HTMLPreElement>("pre[aria-label='OJS source']") ?? undefined,
		);

		expect(sourceBlock.textContent).toBe(source);
		expect(sourceBlock.getAttribute("aria-label")).toBe("OJS source");
		controller.abort();
	});

	test("resolves child models from widget_manager when the host prop is unavailable", async () => {
		const childModel = createModel({
			role: "cell",
			name: "answer",
			_values: {},
			_value_names: [],
		});
		let lookupAttempts = 0;
		const model = createModel(
			{
				role: "notebook",
				_spec: { cells: [{ id: 1, mode: "ojs", value: "answer = 42" }] },
				_attachments: {},
				_variables: {},
				_options: {},
				_cell_widgets: ["anywidget:answer"],
			},
			{
				get_model: async (modelId: string) => {
					lookupAttempts += 1;
					if (lookupAttempts === 1) {
						throw new Error("not ready");
					}
					await new Promise((resolve) => window.setTimeout(resolve, 0));
					return lookupAttempts >= 4 && modelId === "answer" ? childModel : undefined;
				},
			},
		);
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: undefined,
		} as unknown as RenderProps<WidgetModel>);

		await waitStep("widget-manager output", () => composedText(el, "42"));
		expect(variableValue(childModel, "answer")).toBe(42);
		expect(await waitFor(() => (variableValue(model, "answer") === 42 ? 42 : undefined))).toBe(42);
		controller.abort();
	});

	test("reports unsupported composition hosts when no model lookup is available", async () => {
		const model = createModel({
			role: "notebook",
			_spec: { cells: [{ id: 1, mode: "ojs", value: "answer = 42" }] },
			_attachments: {},
			_variables: {},
			_options: {},
			_cell_widgets: ["anywidget:answer"],
		});
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: undefined,
		} as unknown as RenderProps<WidgetModel>);

		expect(await waitFor(() => projectErrorText(el))).toBe(
			"Error: This anywidget host cannot resolve child widget models",
		);
		controller.abort();
	});

	test("reports unresolved child models without blocking resolved value sync", async () => {
		const answerModel = createModel({
			role: "cell",
			name: "answer",
			_values: {},
			_value_names: [],
		});
		const model = createModel(
			{
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
			},
			{
				get_model: async (modelId: string) => (modelId === "answer" ? answerModel : undefined),
			},
		);
		const childModels = new Map([["anywidget:answer", answerModel]]);
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: createHost(childModels),
		} as unknown as RenderProps<WidgetModel>);

		await waitStep("resolved cell output", () => composedText(el, "42"));
		const renderedCells = await waitFor(() => {
			const cells = Array.from(el.querySelectorAll<HTMLElement>(SELECTORS.composedCell));
			return cells.length === 2 ? cells : undefined;
		});
		expect(renderedCells[0]?.textContent?.trim()).toBe("42");
		expect(projectErrorText(renderedCells[0]!)).toBeUndefined();
		expect(variableValue(answerModel, "answer")).toBe(42);
		expect(await waitFor(() => (variableValue(model, "answer") === 42 ? 42 : undefined))).toBe(42);
		const graph = await waitFor(() => graphValue(model), 1500);
		expect(graph.cells[0]?.defines).toEqual(["answer"]);
		expect(graph.cells[1]?.defines).toEqual(["broken"]);
		expect(graph.edges).toContainEqual({ from: 1, to: 2, variable: "answer" });
		expect(await waitFor(() => projectErrorText(renderedCells[1]!), 1500)).toBe(
			"Error: Unknown widget model anywidget:broken",
		);
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

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: createHost(new Map()),
		} as unknown as RenderProps<WidgetModel>);

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
