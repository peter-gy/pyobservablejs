// @vitest-environment jsdom

import type { RenderProps } from "@anywidget/types";
import { describe, expect, test } from "vitest";
import type { NotebookGraph } from "./observable/types";
import { SELECTORS } from "./widget/dom-contract";
import type { WidgetModel } from "./widget/types";
import widget from "./widget";
import { createHost, createModel, variableValue, waitFor } from "./widget-test-utils";
import { composedText, projectErrorText, waitStep } from "./widget-dom-test-utils";

describe("widget composition lifecycle", () => {
	test("renders direct cell displays as unsupported", () => {
		const model = createModel({
			role: "cell",
			name: "answer",
			_values: { answer: 42 },
			_value_names: ["answer"],
		});
		const el = document.createElement("div");

		widget.render({
			model,
			el,
			signal: new AbortController().signal,
			host: undefined,
		} as unknown as RenderProps<WidgetModel>);

		expect(projectErrorText(el)).toBe("Error: NotebookCell renders only inside its parent Notebook display");
		expect(el.textContent?.trim()).toBe("Error: NotebookCell renders only inside its parent Notebook display");
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
			spec: { cells: [{ id: 1, mode: "ojs", value: "answer = 42" }] },
			attachments: {},
			_variables: {},
			options: {},
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
		expect(lookupAttempts).toBeGreaterThanOrEqual(3);
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
				spec: { cells: [{ id: 1, mode: "ojs", value: "answer = 42" }] },
				attachments: {},
				_variables: {},
				options: {},
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
		expect(lookupAttempts).toBeGreaterThanOrEqual(4);
		expect(variableValue(childModel, "answer")).toBe(42);
		expect(await waitFor(() => (variableValue(model, "answer") === 42 ? 42 : undefined))).toBe(42);
		controller.abort();
	});

	test("reports unsupported composition hosts when no model lookup is available", async () => {
		const model = createModel({
			role: "notebook",
			spec: { cells: [{ id: 1, mode: "ojs", value: "answer = 42" }] },
			attachments: {},
			_variables: {},
			options: {},
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
				spec: {
					cells: [
						{ id: 1, mode: "ojs", value: "answer = 42" },
						{ id: 2, mode: "ojs", value: "broken = answer + 1" },
					],
				},
				attachments: {},
				_variables: {},
				options: {},
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
		const graph = await waitFor(() => model.get("_graph") as NotebookGraph | undefined, 1500);
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

		model.set("spec", {
			cells: [{ id: 1, mode: "ojs", value: "answer = 42" }],
		});
		model.set("_cell_widgets", ["anywidget:answer"]);
		expect(el.childElementCount).toBe(0);
	});
});
