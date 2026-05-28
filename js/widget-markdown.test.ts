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

		const strong = await waitFor(() => {
			const error = el.querySelector(SELECTORS.error)?.textContent;
			if (error) throw new Error(error);
			const candidate = el.querySelector("strong");
			return candidate?.textContent === "1. Import the library" ? candidate : undefined;
		});

		expect(strong.textContent).toBe("1. Import the library");
		expect(el.textContent).toContain("Version 119.1 was the latest when this notebook was written.");
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
			const candidate = el.querySelector("strong");
			return /^(initial|updated) 1$/.test(candidate?.textContent ?? "") ? candidate : undefined;
		});

		model.set("_variable_update", { seq: 1, kind: "set", values: { gain: 2 } });

		const strong = await waitFor(() => {
			const error = el.querySelector(SELECTORS.error)?.textContent;
			if (error) throw new Error(error);
			return Array.from(el.querySelectorAll("strong")).find((candidate) => candidate.textContent === "updated 2");
		});

		expect(strong.textContent).toBe("updated 2");
		controller.abort();
	});

	test("does not rewrite notebook-defined md functions in ObservableHQ imports", async () => {
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

		const text = await waitFor(() => {
			const error = el.querySelector(SELECTORS.error)?.textContent;
			if (error) throw new Error(error);
			return el.textContent?.includes("CUSTOM:** custom**") ? el.textContent : undefined;
		});

		expect(text).toContain("CUSTOM:** custom**");
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

		const text = await waitFor(() => {
			const error = el.querySelector(SELECTORS.error)?.textContent;
			if (error) throw new Error(error);
			return el.textContent?.includes("** 1. Import the library**") ? el.textContent : undefined;
		});

		expect(text).toContain("** 1. Import the library**");
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

		const strong = await waitFor(() => {
			const error = standaloneEl.querySelector(SELECTORS.error)?.textContent;
			if (error) throw new Error(error);
			const candidate = standaloneEl.querySelector("strong");
			return candidate?.textContent === "1. Import the library" ? candidate : undefined;
		});

		expect(strong.textContent).toBe("1. Import the library");
		expect(standaloneEl.textContent).toContain("Version 119.1 was the latest when this notebook was written.");
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
			const strong = el.querySelector("strong");
			const candidate = el.querySelector("code");
			return strong?.textContent === "Heading" && candidate?.textContent?.includes("** example**")
				? candidate
				: undefined;
		});

		expect(code.textContent).toContain("```md");
		expect(code.textContent).toContain("** example**");
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
			const strong = el.querySelector("strong");
			const candidate = el.querySelector("code");
			return strong?.textContent === "Heading" && candidate?.textContent?.trimEnd() === "** example**"
				? candidate
				: undefined;
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
			const strong = el.querySelector("strong");
			const candidate = el.querySelector("code");
			return strong?.textContent === "Heading" && candidate?.textContent?.includes("** example**")
				? candidate
				: undefined;
		});

		expect(code.textContent).toContain("** example**");
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
			const strong = el.querySelector("strong");
			const candidate = el.querySelector("code");
			return strong?.textContent === "Heading" && candidate?.textContent?.includes("** example**")
				? candidate
				: undefined;
		});

		expect(code.textContent).toContain("** example**");
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

		const text = await waitFor(() => {
			const error = el.querySelector(SELECTORS.error)?.textContent;
			if (error) throw new Error(error);
			return el.textContent?.includes("** 1. Import the library**") ? el.textContent : undefined;
		});

		expect(text).toContain("** 1. Import the library**");
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
			const strong = el.querySelector("strong");
			const candidate = el.querySelector("code");
			return strong?.textContent === "Heading" && candidate?.textContent?.trimEnd() === "** example**"
				? candidate
				: undefined;
		});

		expect(code.textContent?.trimEnd()).toBe("** example**");
		controller.abort();
	});
});
