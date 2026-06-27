// @vitest-environment jsdom

import type { RenderProps } from "@anywidget/types";
import { describe, expect, test } from "vitest";
import type { WidgetModel } from "@/widget/state";
import devWidget from "@/widget/dev";
import { composedText, createHost, createModel, hasSavedTrait, variableValue, waitFor } from "@/_tests/testing";

describe("widget entrypoint", () => {
	test("dev entry renders direct child cells from the parent notebook model", async () => {
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

		devWidget.render({
			model,
			el,
			signal: controller.signal,
			host: createHost(new Map([["anywidget:notebook", parentModel]])),
		} as unknown as RenderProps<WidgetModel>);

		await waitFor(() => composedText(el, "42"));
		expect(variableValue(model, "answer")).toBe(42);
		expect(hasSavedTrait(model, "_anywidget_bundle_module_request")).toBe(false);
		controller.abort();
	});

	test("dev entry renders notebooks from the Vite module graph", async () => {
		const model = createModel({
			role: "notebook",
			_spec: { cells: [{ id: 1, mode: "ojs", value: "answer = 42" }] },
			_attachments: {},
			_variables: {},
			_options: {},
			_cell_widgets: ["anywidget:answer"],
		});
		const childModel = createModel({ role: "cell", name: "answer", _values: {}, _value_names: [] });
		const controller = new AbortController();
		const el = document.createElement("div");

		devWidget.render({
			model,
			el,
			signal: controller.signal,
			host: createHost(new Map([["anywidget:answer", childModel]])),
		} as unknown as RenderProps<WidgetModel>);

		await waitFor(() => (el.textContent.trim() === "42" ? true : undefined));

		expect(hasSavedTrait(model, "_anywidget_bundle_module_request")).toBe(false);
		controller.abort();
	});
});
