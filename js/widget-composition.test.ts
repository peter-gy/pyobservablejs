// @vitest-environment jsdom

import type { RenderProps } from "@anywidget/types";
import { describe, expect, test } from "vitest";
import { SELECTORS } from "./widget/dom-contract";
import type { WidgetModel } from "./widget/types";
import widget from "./widget";
import {
	type ChildRender,
	createCellExports,
	createCellExportsMap,
	createHost,
	createModel,
	renderChildrenThroughWidget,
	variableValue,
	waitFor,
} from "./widget-test-utils";
import { composedText, projectErrorText, standaloneText, waitStep } from "./widget-dom-test-utils";

describe("widget composition lifecycle", () => {
	test("renders composed cells through the host child render lifecycle", async () => {
		const model = createModel({
			role: "notebook",
			spec: { cells: [{ id: 1, mode: "ojs", value: "answer = 42" }] },
			attachments: {},
			_variables: {},
			options: {},
			_cell_widgets: ["anywidget:answer"],
		});
		const childInitModel = createModel({
			role: "cell",
			_cell_id: "answer-cell",
			name: "answer",
			_values: {},
			_value_names: [],
		});
		const childRenderModel = createModel({
			role: "cell",
			_cell_id: "answer-cell",
			name: "answer",
			_values: {},
			_value_names: [],
		});
		const childModels = new Map([["anywidget:answer", childRenderModel]]);
		const childExports = new Map([["anywidget:answer", createCellExports(childInitModel)]]);
		const childRenders = new Map<string, ChildRender>([
			[
				"anywidget:answer",
				({ el, signal }) => {
					widget.render({
						model: childRenderModel,
						el,
						signal: signal ?? new AbortController().signal,
						host: createHost(new Map()),
					} as unknown as RenderProps<WidgetModel>);
				},
			],
		]);
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: createHost(childModels, childExports, childRenders),
		} as unknown as RenderProps<WidgetModel>);

		await waitStep("composed output", () => composedText(el, "42"));
		controller.abort();
	});

	test("renders pinned source chrome for cell output", async () => {
		const source = "answer = 42";
		const answerModel = createModel({ role: "cell", name: "answer", _values: {}, _value_names: [] });
		const model = createModel({
			role: "notebook",
			spec: { cells: [{ id: 1, mode: "ojs", value: source, pinned: true }] },
			attachments: {},
			_variables: {},
			options: { show_source: true },
			_cell_widgets: ["anywidget:answer"],
		});
		const childModels = new Map([["anywidget:answer", answerModel]]);
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: createHost(childModels, createCellExportsMap(childModels), renderChildrenThroughWidget(childModels)),
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

	test("renders composed cells through widget_manager when host is absent", async () => {
		let rejectedOnce = false;
		const resolvedModels: Array<ReturnType<typeof createModel>> = [];
		const model = createModel(
			{
				role: "notebook",
				spec: { cells: [{ id: 1, mode: "ojs", value: "answer = 42" }] },
				attachments: {},
				_variables: {},
				options: {},
				_cell_widgets: ["anywidget:answer"],
			},
			{
				get_model: async (modelId: string) => {
					if (modelId !== "answer") return undefined;
					if (!rejectedOnce) {
						rejectedOnce = true;
						throw new Error("not ready");
					}
					const childModel = createModel({
						role: "cell",
						name: "answer",
						_values: {},
						_value_names: [],
					});
					resolvedModels.push(childModel);
					return childModel;
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

		await waitStep("fallback composed output", () => composedText(el, "42"));
		expect(await waitFor(() => (variableValue(model, "answer") === 42 ? 42 : undefined))).toBe(42);
		const renderedModel = resolvedModels.find((childModel) => variableValue(childModel, "answer") === 42);
		if (!renderedModel) throw new Error("Expected the fallback widget manager to render a resolved child model");

		const standaloneEl = document.createElement("div");
		widget.render({
			model: renderedModel,
			el: standaloneEl,
			signal: controller.signal,
			host: undefined,
		} as unknown as RenderProps<WidgetModel>);

		await waitFor(() => standaloneText(standaloneEl, "42"));
		controller.abort();
	});

	test("child render failure ignores later child updates", async () => {
		const model = createModel({
			role: "notebook",
			spec: {
				cells: [
					{ id: 1, mode: "ojs", value: "answer = 42" },
					{ id: 2, mode: "ojs", value: "broken = 1" },
				],
			},
			attachments: {},
			_variables: {},
			options: {},
			_cell_widgets: ["anywidget:answer", "anywidget:broken"],
		});
		const childModels = new Map([
			["anywidget:answer", createModel({ role: "cell", name: "answer", _values: {}, _value_names: [] })],
			["anywidget:broken", createModel({ role: "cell", name: "broken", _values: {}, _value_names: [] })],
		]);
		const childRenders = new Map<string, ChildRender>([
			["anywidget:answer", () => {}],
			[
				"anywidget:broken",
				() => {
					throw new Error("child render failed");
				},
			],
		]);
		const el = document.createElement("div");

		widget.render({
			model,
			el,
			signal: new AbortController().signal,
			host: createHost(childModels, createCellExportsMap(childModels), childRenders),
		} as unknown as RenderProps<WidgetModel>);

		await waitFor(() => projectErrorText(el));

		for (const childModel of childModels.values()) childModel.set("_values", { leaked: true });
		expect(variableValue(model, "leaked")).toBeUndefined();
	});

	test("aborted render ignores later model changes", () => {
		const model = createModel({
			role: "notebook",
			spec: { cells: [] },
			attachments: {},
			_variables: {},
			options: {},
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

		model.set("spec", { cells: [{ id: 1, mode: "ojs", value: "answer = 42" }] });
		model.set("_cell_widgets", ["anywidget:answer"]);
		expect(el.childElementCount).toBe(0);
	});
});
