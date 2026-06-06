// @vitest-environment jsdom

import type { RenderProps } from "@anywidget/types";
import { describe, test } from "vitest";
import { SELECTORS } from "./widget/dom-contract";
import type { WidgetModel } from "./widget/types";
import widget from "./widget/app";
import { createHost, createModel, waitFor } from "./widget-test-utils";

describe("widget markdown rendering", () => {
	test("renders Python-authored Notebook Kit markdown cells", async () => {
		const model = createModel({
			role: "notebook",
			spec: {
				cells: [{ id: 1, mode: "md", value: "# Python rows drive an Observable Plot bar chart" }],
			},
			attachments: {},
			_variables: {},
			options: {},
			_cell_widgets: ["anywidget:title"],
		});
		const childModels = new Map([
			["anywidget:title", createModel({ role: "cell", name: "title", _values: {}, _value_names: [] })],
		]);
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: createHost(childModels),
		} as unknown as RenderProps<WidgetModel>);

		await waitFor(() => {
			const error = el.querySelector(SELECTORS.error)?.textContent;
			if (error) throw new Error(error);
			return Array.from(el.querySelectorAll("h1")).find(
				(item) => item.textContent === "Python rows drive an Observable Plot bar chart",
			);
		});

		controller.abort();
	});

	test("renders source-backed OJS markdown through the Notebook Kit md builtin", async () => {
		const source =
			"<notebook>\n" +
			'  <script id="1" type="application/vnd.observable.javascript">md`**1. Import the library**`</script>\n' +
			"</notebook>";
		const model = createModel({
			role: "notebook",
			source,
			attachments: {},
			_variables: {},
			options: {},
			_cell_widgets: ["anywidget:markdown"],
		});
		const childModels = new Map([
			["anywidget:markdown", createModel({ role: "cell", name: "markdown", _values: {}, _value_names: [] })],
		]);
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: createHost(childModels),
		} as unknown as RenderProps<WidgetModel>);

		await waitFor(() => {
			const error = el.querySelector(SELECTORS.error)?.textContent;
			if (error) throw new Error(error);
			return onlyStrongText(el, "1. Import the library");
		});

		controller.abort();
	});

	test("keeps spaced strong delimiters literal under Notebook Kit markdown", async () => {
		const source =
			"<notebook>\n" +
			'  <script id="1" type="application/vnd.observable.javascript">md`** 1. Import the library**`</script>\n' +
			"</notebook>";
		const model = createModel({
			role: "notebook",
			source,
			attachments: {},
			_variables: {},
			options: {},
			_cell_widgets: ["anywidget:source-ojs-markdown"],
		});
		const childModels = new Map([
			[
				"anywidget:source-ojs-markdown",
				createModel({ role: "cell", name: "sourceOjsMarkdown", _values: {}, _value_names: [] }),
			],
		]);
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: createHost(childModels),
		} as unknown as RenderProps<WidgetModel>);

		await waitFor(() => {
			const error = el.querySelector(SELECTORS.error)?.textContent;
			if (error) throw new Error(error);
			return onlyComposedInspectorString(el, "** 1. Import the library**");
		});

		controller.abort();
	});

	test("uses notebook-defined md bindings for source-backed OJS cells", async () => {
		const source =
			"<notebook>\n" +
			'  <script id="1" type="application/vnd.observable.javascript">md = (template) => `CUSTOM:${template[0]}`</script>\n' +
			'  <script id="2" type="application/vnd.observable.javascript">md`** custom**`</script>\n' +
			"</notebook>";
		const model = createModel({
			role: "notebook",
			source,
			attachments: {},
			_variables: {},
			options: {},
			_cell_widgets: ["anywidget:custom-md", "anywidget:custom-md-call"],
		});
		const childModels = new Map([
			["anywidget:custom-md", createModel({ role: "cell", name: "customMd", _values: {}, _value_names: [] })],
			["anywidget:custom-md-call", createModel({ role: "cell", name: "customMdCall", _values: {}, _value_names: [] })],
		]);
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: createHost(childModels),
		} as unknown as RenderProps<WidgetModel>);

		await waitFor(() => {
			const error = el.querySelector(SELECTORS.error)?.textContent;
			if (error) throw new Error(error);
			return onlyComposedInspectorString(el, "CUSTOM:** custom**");
		});

		controller.abort();
	});

	test("keeps source-backed Notebook Kit JavaScript markdown delimiters literal", async () => {
		const source =
			"<notebook>\n" + '  <script id="1" type="module">md`** 1. Import the library**`</script>\n' + "</notebook>";
		const model = createModel({
			role: "notebook",
			source,
			attachments: {},
			_variables: {},
			options: {},
			_cell_widgets: ["anywidget:module-markdown"],
		});
		const childModels = new Map([
			[
				"anywidget:module-markdown",
				createModel({ role: "cell", name: "moduleMarkdown", _values: {}, _value_names: [] }),
			],
		]);
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: createHost(childModels),
		} as unknown as RenderProps<WidgetModel>);

		await waitFor(() => {
			const error = el.querySelector(SELECTORS.error)?.textContent;
			if (error) throw new Error(error);
			return onlyComposedInspectorString(el, "** 1. Import the library**");
		});

		controller.abort();
	});
});

function onlyStrongText(el: HTMLElement, text: string): HTMLElement | undefined {
	return onlyOutputMatch(el, `strong element with ${text}`, (cell) => {
		const matches = Array.from(cell.querySelectorAll<HTMLElement>("strong")).filter(
			(item) => item.textContent === text,
		);
		if (matches.length === 0) return undefined;
		if (matches.length > 1) throw new Error(`Expected one strong element with ${text}, found ${matches.length}`);
		return matches[0];
	});
}

function onlyComposedInspectorString(el: HTMLElement, value: string): HTMLElement | undefined {
	return onlyComposedText(el, value) ?? onlyComposedText(el, `"${value}"`);
}

function onlyComposedText(el: HTMLElement, value: string): HTMLElement | undefined {
	const matches = Array.from(el.querySelectorAll<HTMLElement>(SELECTORS.composedCell)).filter((cell) => {
		const text = cell.textContent?.trim() ?? "";
		return text === value;
	});
	if (matches.length === 0) return undefined;
	if (matches.length > 1) throw new Error(`Expected one composed cell with ${value}, found ${matches.length}`);
	return matches[0]!;
}

function onlyOutputMatch(
	el: HTMLElement,
	label: string,
	read: (cell: HTMLElement) => HTMLElement | undefined,
): HTMLElement | undefined {
	const matches = outputCells(el)
		.map((cell) => read(cell))
		.filter((item): item is HTMLElement => item !== undefined);
	if (matches.length === 0) return undefined;
	if (matches.length > 1) throw new Error(`Expected one ${label}, found ${matches.length}`);
	return matches[0]!;
}

function outputCells(el: HTMLElement): HTMLElement[] {
	return Array.from(el.querySelectorAll<HTMLElement>(SELECTORS.composedCell));
}
