import { describe, expect, test } from "vite-plus/test";
import createWidget from "../src";
import { composedText, createHost, createModel, initializeProps, renderProps, variableValue, waitFor } from "./testing";

describe("widget routing", () => {
	test("the widget factory renders a Notebook model without host composition", async () => {
		const model = createModel({
			role: "notebook",
			_spec: { cells: [{ id: 1, mode: "ojs", value: "answer = 42" }] },
			_attachments: {},
			_variables: {},
			_options: {},
			_cell_keys: ["answer"],
		});
		const host = createHost(new Map());
		const controller = new AbortController();
		const el = document.createElement("div");
		const definition = createWidget();
		definition.initialize(initializeProps(model, controller.signal));

		await definition.render(renderProps(model, el, controller.signal, host));

		expect(await waitFor(() => composedText(el, "42"))).toBeInstanceOf(HTMLElement);
		expect(variableValue(model, "answer")).toBe(42);
		expect(host.widgetLookups).toEqual([]);
		controller.abort();
	});

	test("a NotebookCell delegates its view to the referenced Notebook widget", async () => {
		const parent = createModel({
			role: "notebook",
			_spec: { cells: [{ id: 1, mode: "ojs", value: "answer = 42" }] },
			_attachments: {},
			_variables: {},
			_options: {},
			_cell_keys: ["answer"],
		});
		const cell = createModel({
			role: "cell",
			name: "answer",
			_notebook_widget: "anywidget:notebook",
			_notebook_index: 0,
		});
		const host = createHost(new Map([["anywidget:notebook", parent]]));
		const controller = new AbortController();
		const el = document.createElement("div");
		const definition = createWidget();
		definition.initialize(initializeProps(cell, controller.signal));

		await definition.render(renderProps(cell, el, controller.signal, host));

		expect(await waitFor(() => composedText(el, "42"))).toBeInstanceOf(HTMLElement);
		expect(variableValue(parent, "answer")).toBe(42);
		expect(host.widgetLookups).toEqual(["anywidget:notebook"]);
		controller.abort();
	});
});
