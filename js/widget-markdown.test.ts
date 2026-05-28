// @vitest-environment jsdom

import type { RenderProps } from "@anywidget/types";
import { describe, expect, test } from "vitest";
import { SELECTORS } from "./dom-contract";
import type { WidgetModel } from "./types";
import widget from "./widget";
import {
	createCellExportsMap,
	createHost,
	createModel,
	renderChildrenThroughWidget,
	waitFor,
} from "./widget-test-utils";

describe("widget markdown compatibility", () => {
	test("renders hosted Observable markdown strong delimiters with interior whitespace", async () => {
		const source =
			"<notebook>\n" +
			'  <script id="1" type="application/vnd.observable.javascript">md`** 1. Import the library**\n\nVersion 119.1 was the latest when this notebook was written.`</script>\n' +
			"</notebook>";
		const model = createModel({
			role: "notebook",
			source,
			attachments: {},
			_variables: {},
			options: { observable_markdown_compatibility: true },
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
			host: createHost(childModels, createCellExportsMap(childModels), renderChildrenThroughWidget(childModels)),
		} as unknown as RenderProps<WidgetModel>);

		await waitFor(() => {
			const error = el.querySelector(SELECTORS.error)?.textContent;
			if (error) throw new Error(error);
			return outputWithStrongAndParagraph(
				el,
				"1. Import the library",
				"Version 119.1 was the latest when this notebook was written.",
			);
		});

		controller.abort();
	});

	test("preserves the Observable previous value receiver when wrapping markdown", async () => {
		const source =
			"<notebook>\n" +
			'  <script id="1" type="application/vnd.observable.javascript">md`** ${this ? "updated" : "initial"} ${gain}**`</script>\n' +
			"</notebook>";
		const model = createModel({
			role: "notebook",
			source,
			attachments: {},
			_variables: { gain: 1 },
			_variable_update: {},
			options: { observable_markdown_compatibility: true },
			_cell_widgets: ["anywidget:readout"],
		});
		const childModels = new Map([
			["anywidget:readout", createModel({ role: "cell", name: "readout", _values: {}, _value_names: [] })],
		]);
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: createHost(childModels, createCellExportsMap(childModels), renderChildrenThroughWidget(childModels)),
		} as unknown as RenderProps<WidgetModel>);

		await waitFor(() => {
			const error = el.querySelector(SELECTORS.error)?.textContent;
			if (error) throw new Error(error);
			return onlyStrongText(el, "initial 1");
		});

		model.set("_variable_update", { seq: 1, kind: "set", values: { gain: 2 } });

		await waitFor(() => {
			const error = el.querySelector(SELECTORS.error)?.textContent;
			if (error) throw new Error(error);
			return onlyStrongText(el, "updated 2");
		});
		expect(Array.from(el.querySelectorAll("strong"), (item) => item.textContent)).toEqual(["updated 2"]);

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
			options: { observable_markdown_compatibility: true },
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
			host: createHost(childModels, createCellExportsMap(childModels), renderChildrenThroughWidget(childModels)),
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
			host: createHost(childModels, createCellExportsMap(childModels), renderChildrenThroughWidget(childModels)),
		} as unknown as RenderProps<WidgetModel>);

		await waitFor(() => {
			const error = el.querySelector(SELECTORS.error)?.textContent;
			if (error) throw new Error(error);
			return onlyComposedInspectorString(el, "** 1. Import the library**");
		});

		controller.abort();
	});

	test("renders hosted Observable markdown in standalone child cells", async () => {
		const source =
			"<notebook>\n" +
			'  <script id="1" type="application/vnd.observable.javascript">md`** 1. Import the library**\n\nVersion 119.1 was the latest when this notebook was written.`</script>\n' +
			"</notebook>";
		const model = createModel({
			role: "notebook",
			source,
			attachments: {},
			_variables: {},
			options: { observable_markdown_compatibility: true },
			_cell_widgets: ["anywidget:markdown"],
		});
		const markdownModel = createModel({ role: "cell", name: "markdown", _values: {}, _value_names: [] });
		const childModels = new Map([["anywidget:markdown", markdownModel]]);
		const controller = new AbortController();

		widget.render({
			model,
			el: document.createElement("div"),
			signal: controller.signal,
			host: createHost(childModels, createCellExportsMap(childModels), renderChildrenThroughWidget(childModels)),
		} as unknown as RenderProps<WidgetModel>);

		const standaloneEl = document.createElement("div");
		widget.render({
			model: markdownModel,
			el: standaloneEl,
			signal: controller.signal,
			host: createHost(new Map()),
		} as unknown as RenderProps<WidgetModel>);

		await waitFor(() => {
			const error = standaloneEl.querySelector(SELECTORS.error)?.textContent;
			if (error) throw new Error(error);
			return outputWithStrongAndParagraph(
				standaloneEl,
				"1. Import the library",
				"Version 119.1 was the latest when this notebook was written.",
			);
		});

		controller.abort();
	});

	test("leaves fenced hosted Observable markdown examples unchanged", async () => {
		const source = [
			"<notebook>",
			'  <script id="1" type="application/vnd.observable.javascript">md`** Heading**',
			"",
			"\\`\\`\\`\\`md",
			"\\`\\`\\`md",
			"** example**",
			"\\`\\`\\`",
			"\\`\\`\\`\\``</script>",
			"</notebook>",
		].join("\n");
		const model = createModel({
			role: "notebook",
			source,
			attachments: {},
			_variables: {},
			options: { observable_markdown_compatibility: true },
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
			host: createHost(childModels, createCellExportsMap(childModels), renderChildrenThroughWidget(childModels)),
		} as unknown as RenderProps<WidgetModel>);

		const code = await waitFor(() => {
			const error = el.querySelector(SELECTORS.error)?.textContent;
			if (error) throw new Error(error);
			return codeWithHeading(el, "Heading", (text) => text.trimEnd() === "```md\n** example**\n```");
		});

		expect(code.textContent?.trimEnd()).toBe("```md\n** example**\n```");
		controller.abort();
	});

	test("leaves blockquoted fenced hosted Observable markdown examples unchanged", async () => {
		const source = [
			"<notebook>",
			'  <script id="1" type="application/vnd.observable.javascript">md`** Heading**',
			"",
			"> \\`\\`\\`md",
			"> ** example**",
			"> \\`\\`\\``</script>",
			"</notebook>",
		].join("\n");
		const model = createModel({
			role: "notebook",
			source,
			attachments: {},
			_variables: {},
			options: { observable_markdown_compatibility: true },
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
			host: createHost(childModels, createCellExportsMap(childModels), renderChildrenThroughWidget(childModels)),
		} as unknown as RenderProps<WidgetModel>);

		const code = await waitFor(() => {
			const error = el.querySelector(SELECTORS.error)?.textContent;
			if (error) throw new Error(error);
			return codeWithHeading(el, "Heading", (text) => text.trimEnd() === "** example**");
		});

		expect(code.textContent?.trimEnd()).toBe("** example**");
		controller.abort();
	});

	test("keeps interpolated hosted Observable markdown fences open across template chunks", async () => {
		const source = [
			"<notebook>",
			'  <script id="1" type="application/vnd.observable.javascript">md`** Heading**',
			"",
			"\\`\\`\\`\\`md",
			'${""}',
			"** example**",
			"\\`\\`\\`\\``</script>",
			"</notebook>",
		].join("\n");
		const model = createModel({
			role: "notebook",
			source,
			attachments: {},
			_variables: {},
			options: { observable_markdown_compatibility: true },
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
			host: createHost(childModels, createCellExportsMap(childModels), renderChildrenThroughWidget(childModels)),
		} as unknown as RenderProps<WidgetModel>);

		const code = await waitFor(() => {
			const error = el.querySelector(SELECTORS.error)?.textContent;
			if (error) throw new Error(error);
			return codeWithHeading(el, "Heading", (text) => nonblankLines(text).join("\n") === "** example**");
		});

		expect(nonblankLines(code.textContent ?? "")).toEqual(["** example**"]);
		controller.abort();
	});

	test("uses primitive markdown interpolations when detecting hosted Observable code fences", async () => {
		const source = [
			"<notebook>",
			'  <script id="1" type="application/vnd.observable.javascript">md`** Heading**',
			"",
			'${"````md"}',
			"** example**",
			"\\`\\`\\`\\``</script>",
			"</notebook>",
		].join("\n");
		const model = createModel({
			role: "notebook",
			source,
			attachments: {},
			_variables: {},
			options: { observable_markdown_compatibility: true },
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
			host: createHost(childModels, createCellExportsMap(childModels), renderChildrenThroughWidget(childModels)),
		} as unknown as RenderProps<WidgetModel>);

		const code = await waitFor(() => {
			const error = el.querySelector(SELECTORS.error)?.textContent;
			if (error) throw new Error(error);
			return codeWithHeading(el, "Heading", (text) => text.trimEnd() === "** example**");
		});

		expect(code.textContent?.trimEnd()).toBe("** example**");
		controller.abort();
	});

	test("keeps source-backed OJS markdown delimiters literal without ObservableHQ compatibility", async () => {
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
			host: createHost(childModels, createCellExportsMap(childModels), renderChildrenThroughWidget(childModels)),
		} as unknown as RenderProps<WidgetModel>);

		await waitFor(() => {
			const error = el.querySelector(SELECTORS.error)?.textContent;
			if (error) throw new Error(error);
			return onlyComposedInspectorString(el, "** 1. Import the library**");
		});

		controller.abort();
	});

	test("leaves indented hosted Observable markdown code unchanged", async () => {
		const model = createModel({
			role: "notebook",
			source:
				"<notebook>\n" +
				'  <script id="1" type="application/vnd.observable.javascript">md`** Heading**\n\n        ** example**`</script>\n' +
				"</notebook>",
			attachments: {},
			_variables: {},
			options: { observable_markdown_compatibility: true },
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
			host: createHost(childModels, createCellExportsMap(childModels), renderChildrenThroughWidget(childModels)),
		} as unknown as RenderProps<WidgetModel>);

		const code = await waitFor(() => {
			const error = el.querySelector(SELECTORS.error)?.textContent;
			if (error) throw new Error(error);
			return codeWithHeading(el, "Heading", (text) => text.trimEnd() === "** example**");
		});

		expect(code.textContent?.trimEnd()).toBe("** example**");
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

function outputWithStrongAndParagraph(
	el: HTMLElement,
	strongText: string,
	paragraphText: string,
): HTMLElement | undefined {
	return onlyOutputMatch(el, `output with ${strongText} and ${paragraphText}`, (cell) => {
		const strong = Array.from(cell.querySelectorAll<HTMLElement>("strong")).filter(
			(item) => item.textContent === strongText,
		);
		const paragraphs = Array.from(cell.querySelectorAll<HTMLElement>("p")).filter(
			(item) => item.textContent === paragraphText,
		);
		if (strong.length === 0 || paragraphs.length === 0) return undefined;
		if (strong.length > 1) throw new Error(`Expected one strong element with ${strongText}, found ${strong.length}`);
		if (paragraphs.length > 1)
			throw new Error(`Expected one paragraph with ${paragraphText}, found ${paragraphs.length}`);
		return cell;
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

function codeWithHeading(
	el: HTMLElement,
	heading: string,
	matchesCode: (text: string) => boolean,
): HTMLElement | undefined {
	return onlyOutputMatch(el, `code block under ${heading}`, (cell) => {
		const headings = Array.from(cell.querySelectorAll<HTMLElement>("strong")).filter(
			(item) => item.textContent === heading,
		);
		if (headings.length === 0) return undefined;
		const matches = Array.from(cell.querySelectorAll<HTMLElement>("pre code")).filter((code) =>
			matchesCode(code.textContent ?? ""),
		);
		if (matches.length === 0) return undefined;
		if (headings.length > 1) throw new Error(`Expected one heading ${heading}, found ${headings.length}`);
		if (matches.length > 1) throw new Error(`Expected one code block under ${heading}, found ${matches.length}`);
		return matches[0];
	});
}

function nonblankLines(text: string): string[] {
	return text
		.split(/\r\n|\n|\r/)
		.map((line) => line.trimEnd())
		.filter((line) => line.trim() !== "");
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
	return Array.from(el.querySelectorAll<HTMLElement>(`${SELECTORS.composedCell}, ${SELECTORS.standaloneCell}`));
}
