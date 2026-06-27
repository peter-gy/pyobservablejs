// @vitest-environment jsdom

import type { RenderProps } from "@anywidget/types";
import { describe, expect, test } from "vitest";
import type { WidgetModel } from "@/widget/state";
import widget from "@/widget/index";
import devWidget from "@/widget/dev";
import { createHost, createModel, hasSavedTrait, waitFor } from "@/_tests/testing";

describe("widget entrypoint", () => {
	test("renders child cells as parent-owned outputs without requesting module source", () => {
		const model = createModel({ role: "cell", name: "answer", _values: {}, _value_names: [] });
		const el = document.createElement("div");

		widget.render({ model, el, signal: new AbortController().signal } as unknown as RenderProps<WidgetModel>);

		expect(el.textContent?.trim()).toBe("Error: NotebookCell renders only inside its parent Notebook display");
		expect(hasSavedTrait(model, "_anywidget_bundle_module_request")).toBe(false);
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
