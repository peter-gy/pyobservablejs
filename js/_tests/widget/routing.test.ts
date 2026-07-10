// @vitest-environment jsdom

import type { AnyWidget, Initialize, Render } from "@anywidget/types";
import { describe, expect, test } from "vitest";
import widget from "@/widget/app";
import type { WidgetModel } from "@/widget/model";
import {
	composedText,
	createHost,
	createModel,
	initializeProps,
	renderProps,
	variableValue,
	waitFor,
} from "@/_tests/testing";

type WidgetDefinition = {
	initialize?: Initialize<WidgetModel>;
	render?: Render<WidgetModel>;
};

describe("widget routing", () => {
	test("renders direct child cells from the parent notebook model", async () => {
		const parentModel = createModel({
			role: "notebook",
			_spec: { cells: [{ id: 1, mode: "ojs", value: "answer = 42" }] },
			_attachments: {},
			_variables: {},
			_options: {},
			_cell_widgets: ["anywidget:answer"],
		});
		const model = createModel({
			role: "cell",
			name: "answer",
			_notebook_widget: "anywidget:notebook",
			_notebook_index: 0,
			_values: {},
			_value_names: [],
		});
		const el = document.createElement("div");
		const controller = new AbortController();

		const definition = await initializeWidget(widget, model, controller.signal);
		await definition.render?.(
			renderProps(model, el, controller.signal, createHost(new Map([["anywidget:notebook", parentModel]]))),
		);

		await waitFor(() => composedText(el, "42"));
		expect(variableValue(model, "answer")).toBe(42);
		expect(model.get("_has_rendered")).toBe(true);
		expect(parentModel.get("_has_rendered")).toBeUndefined();
		controller.abort();
	});

	test("renders notebooks from the application module", async () => {
		const model = createModel({
			role: "notebook",
			_spec: { cells: [{ id: 1, mode: "ojs", value: "answer = 42" }] },
			_attachments: {},
			_variables: {},
			_options: {},
			_cell_widgets: ["anywidget:answer"],
		});
		const childModel = createModel({
			role: "cell",
			name: "answer",
			_values: {},
			_value_names: [],
		});
		const controller = new AbortController();
		const el = document.createElement("div");

		const definition = await initializeWidget(widget, model, controller.signal);
		await definition.render?.(
			renderProps(model, el, controller.signal, createHost(new Map([["anywidget:answer", childModel]]))),
		);

		await waitFor(() => (el.textContent.trim() === "42" ? true : undefined));

		controller.abort();
	});

	test("renders with model-manager lookup when the render host is omitted", async () => {
		const model = createModel({
			role: "notebook",
			_spec: { cells: [{ id: 1, mode: "ojs", value: "answer = 42" }] },
			_attachments: {},
			_variables: {},
			_options: {},
			_cell_widgets: ["anywidget:answer"],
		});
		const childModel = createModel({
			role: "cell",
			name: "answer",
			_values: {},
			_value_names: [],
		});
		const modelIds: string[] = [];
		model.widget_manager = {
			async get_model(modelId) {
				modelIds.push(modelId);
				if (modelId !== "answer") throw new Error(`Unknown widget model ${modelId}`);
				return childModel as never;
			},
		};
		const controller = new AbortController();
		const el = document.createElement("div");
		const definition = await initializeWidget(widget, model, controller.signal);
		const props = renderProps(model, el, controller.signal);

		await definition.render?.({ ...props, host: undefined as never });

		expect(await waitFor(() => (variableValue(childModel, "answer") === 42 ? 42 : undefined))).toBe(42);
		expect(modelIds).toEqual(["answer"]);
		controller.abort();
	});
});

async function initializeWidget(
	widget: AnyWidget<WidgetModel>,
	model: ReturnType<typeof createModel>,
	signal: AbortSignal,
): Promise<WidgetDefinition> {
	const definition = typeof widget === "function" ? await widget() : widget;
	await definition.initialize?.(initializeProps(model, signal));
	return definition;
}
