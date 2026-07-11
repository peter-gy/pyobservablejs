import { describe, expect, test } from "vite-plus/test";
import createWidget from "../src";
import {
	alertText,
	composedText,
	createHost,
	createSession,
	createView,
	initializeProps,
	renderProps,
	variableValue,
	waitFor,
} from "./testing";

describe("widget routing", () => {
	test("a NotebookView resolves its session model without reverse widget rendering", async () => {
		const session = createSession({
			_spec: { cells: [{ id: 1, mode: "ojs", value: "answer = 42" }] },
			_attachments: {},
			_variables: {},
			_options: {},
			_cell_keys: ["answer"],
		});
		const view = createView();
		const host = createHost(new Map([["anywidget:session", session]]));
		const controller = new AbortController();
		const el = document.createElement("div");
		const definition = createWidget();
		definition.initialize(initializeProps(view, controller.signal));

		definition.render(renderProps(view, el, controller.signal, host));

		expect(await waitFor(() => composedText(el, "42"))).toBeInstanceOf(HTMLElement);
		expect(variableValue(view, "answer")).toBe(42);
		expect(host.modelLookups).toEqual(["anywidget:session"]);
		expect(host.widgetLookups).toEqual([]);
		controller.abort();
	});

	test("a Notebook session is not a display model", async () => {
		const session = createSession({ _spec: { cells: [] }, _variables: {}, _options: {} });
		const controller = new AbortController();
		const el = document.createElement("div");
		const definition = createWidget();
		definition.initialize(initializeProps(session, controller.signal));

		definition.render(renderProps(session, el, controller.signal));

		expect(await waitFor(() => alertText(el))).toBe(
			"Error: Notebook sessions are not displayable. Display notebook.view() instead.",
		);
		controller.abort();
	});

	test("reports missing and invalid session references", async () => {
		const missing = createView("", null);
		const wrongRole = createView("anywidget:wrong", null);
		const wrong = createView("anywidget:unused", null);
		const missingController = new AbortController();
		const wrongController = new AbortController();
		const missingEl = document.createElement("div");
		const wrongEl = document.createElement("div");

		createWidget().render(renderProps(missing, missingEl, missingController.signal));
		createWidget().render(
			renderProps(wrongRole, wrongEl, wrongController.signal, createHost(new Map([["anywidget:wrong", wrong]]))),
		);

		expect(await waitFor(() => alertText(missingEl))).toBe("Error: NotebookView has no Notebook session reference");
		expect(await waitFor(() => alertText(wrongEl))).toBe(
			"Error: NotebookView reference does not resolve to a Notebook session",
		);
		missingController.abort();
		wrongController.abort();
	});

	test("rejects duplicate and empty cell indexes from malformed wire state", async () => {
		const duplicate = createView("anywidget:session", [0, 0]);
		const empty = createView("anywidget:session", []);
		const duplicateController = new AbortController();
		const emptyController = new AbortController();
		const duplicateEl = document.createElement("div");
		const emptyEl = document.createElement("div");

		createWidget().render(renderProps(duplicate, duplicateEl, duplicateController.signal));
		createWidget().render(renderProps(empty, emptyEl, emptyController.signal));

		expect(await waitFor(() => alertText(duplicateEl))).toBe("Error: NotebookView cell indexes must be unique");
		expect(await waitFor(() => alertText(emptyEl))).toBe("Error: NotebookView cell indexes must not be empty");
		duplicateController.abort();
		emptyController.abort();
	});
});
