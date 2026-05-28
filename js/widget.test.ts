// @vitest-environment jsdom

import type { RenderProps } from "@anywidget/types";
import { toNotebook } from "@observablehq/notebook-kit";
import { describe, expect, test } from "vitest";
import { SELECTORS } from "./dom-contract";
import type { CellRenderContext, NotebookGraph, WidgetModel } from "./types";
import widget from "./widget";
import {
	type ChildRender,
	createCellExports,
	createCellExportsMap,
	createHost,
	createModel,
	renderChildrenThroughWidget,
	trackingCellExports,
	variableValue,
	waitFor,
} from "./widget-test-utils";

describe("widget graph sync", () => {
	test("writes the Notebook Kit graph to the notebook model after child models resolve", async () => {
		const model = createModel({
			role: "notebook",
			spec: {
				cells: [
					{ id: 1, mode: "ojs", value: "answer = 42" },
					{ id: 2, mode: "ojs", value: "answer + 1" },
				],
			},
			attachments: {},
			_variables: {},
			options: {},
			_cell_widgets: ["anywidget:cell-1", "anywidget:cell-2"],
		});
		const childModels = new Map([
			["anywidget:cell-1", createModel({ role: "cell", name: "answer", _values: {}, _value_names: [] })],
			["anywidget:cell-2", createModel({ role: "cell", name: "readout", _values: {}, _value_names: [] })],
		]);
		const controller = new AbortController();

		widget.render({
			model,
			el: document.createElement("div"),
			signal: controller.signal,
			host: createHost(childModels),
		} as unknown as RenderProps<WidgetModel>);

		const graph = await waitFor(() => model.get("_graph") as NotebookGraph | undefined);

		expect(graph.cells.map((cell) => cell.name)).toEqual(["answer", "readout"]);
		expect(graph.cells.map((cell) => cell.defines)).toEqual([["answer"], []]);
		expect(graph.cells[1]?.references).toEqual(["answer"]);
		expect(graph.edges).toEqual([{ from: 1, to: 2, variable: "answer" }]);
		const childModel = childModels.get("anywidget:cell-1") as unknown as {
			get(name: string): unknown;
		};
		expect(childModel.get("_info")).toBeUndefined();
		controller.abort();
	});

	test("keeps notebook values reactive to slider-like child variable updates", async () => {
		const model = createModel({
			role: "notebook",
			spec: {
				cells: [
					{ id: 1, mode: "ojs", value: "viewof gain = Inputs.range([0, 11], {value: 5})" },
					{ id: 2, mode: "ojs", value: "gain * 2" },
				],
			},
			attachments: {},
			_variables: {},
			options: {},
			_cell_widgets: ["anywidget:gain", "anywidget:readout"],
		});
		const childModels = new Map([
			["anywidget:gain", createModel({ role: "cell", name: "gain", _values: {}, _value_names: [] })],
			["anywidget:readout", createModel({ role: "cell", name: "readout", _values: {}, _value_names: [] })],
		]);
		const controller = new AbortController();

		widget.render({
			model,
			el: document.createElement("div"),
			signal: controller.signal,
			host: createHost(childModels),
		} as unknown as RenderProps<WidgetModel>);
		await waitFor(() => model.get("_graph") as NotebookGraph | undefined);

		const gainModel = childModels.get("anywidget:gain");
		gainModel?.set("_value_names", ["gain"]);
		gainModel?.set("_values", { gain: 5 });
		expect(await waitFor(() => variableValue(model, "gain"))).toBe(5);

		gainModel?.set("_values", { gain: 7.5 });
		const changedGain = await waitFor(() => (variableValue(model, "gain") === 7.5 ? 7.5 : undefined));

		childModels.get("anywidget:readout")?.set("_value_names", ["readout"]);
		childModels.get("anywidget:readout")?.set("_values", { readout: 15 });
		await waitFor(() => variableValue(model, "readout"));

		expect(changedGain).toBe(7.5);
		expect(model.get("_values")).toEqual({ gain: 7.5, readout: 15 });
		expect(model.get("_value_names")).toEqual(["gain", "readout"]);
		controller.abort();
	});

	test("syncs named display cell values under the cell name", async () => {
		const model = createModel({
			role: "notebook",
			spec: {
				cells: [
					{ id: 1, mode: "ojs", value: "answer = 42" },
					{ id: 2, mode: "ojs", value: "answer + 1" },
				],
			},
			attachments: {},
			_variables: {},
			options: {},
			_cell_widgets: ["anywidget:answer", "anywidget:readout"],
		});
		const readoutModel = createModel({ role: "cell", name: "readout", _values: {}, _value_names: [] });
		const childModels = new Map([
			["anywidget:answer", createModel({ role: "cell", name: "answer", _values: {}, _value_names: [] })],
			["anywidget:readout", readoutModel],
		]);
		const controller = new AbortController();

		widget.render({
			model,
			el: document.createElement("div"),
			signal: controller.signal,
			host: createHost(childModels, createCellExportsMap(childModels), renderChildrenThroughWidget(childModels)),
		} as unknown as RenderProps<WidgetModel>);

		expect(await waitFor(() => (variableValue(readoutModel, "readout") === 43 ? 43 : undefined))).toBe(43);
		expect(await waitFor(() => (variableValue(model, "readout") === 43 ? 43 : undefined))).toBe(43);
		controller.abort();
	});

	test("lets Python variables override notebook-defined variables", async () => {
		const model = createModel({
			role: "notebook",
			spec: {
				cells: [
					{ id: 1, mode: "ojs", value: "answer = 1" },
					{ id: 2, mode: "ojs", value: "doubled = answer * 2" },
				],
			},
			attachments: {},
			_variables: { answer: 41, unused: 1 },
			options: {},
			_cell_widgets: ["anywidget:answer", "anywidget:doubled"],
		});
		const childModels = new Map([
			["anywidget:answer", createModel({ role: "cell", name: "answer", _values: {}, _value_names: [] })],
			["anywidget:doubled", createModel({ role: "cell", name: "doubled", _values: {}, _value_names: [] })],
		]);
		const childExports = createCellExportsMap(childModels);
		const childRenders = renderChildrenThroughWidget(childModels);
		const controller = new AbortController();

		widget.render({
			model,
			el: document.createElement("div"),
			signal: controller.signal,
			host: createHost(childModels, childExports, childRenders),
		} as unknown as RenderProps<WidgetModel>);

		expect(
			await waitFor(() => (variableValue(childModels.get("anywidget:answer")!, "answer") === 41 ? 41 : undefined)),
		).toBe(41);
		expect(await waitFor(() => (variableValue(model, "doubled") === 82 ? 82 : undefined))).toBe(82);

		const standaloneEl = document.createElement("div");
		widget.render({
			model: childModels.get("anywidget:answer")!,
			el: standaloneEl,
			signal: controller.signal,
			host: createHost(new Map()),
		} as unknown as RenderProps<WidgetModel>);

		expect(await waitFor(() => (standaloneEl.textContent?.includes("41") ? standaloneEl.textContent : undefined))).toBe(
			"41",
		);
		controller.abort();
	});

	test("overrides source-backed variables without breaking URL-backed attachments", async () => {
		const model = createModel({
			role: "notebook",
			source: `
<notebook>
  <script id="1" type="application/vnd.observable.javascript" name="rows">rows = [{x: 0}, {x: 1}, {x: 2}]</script>
  <script id="2" type="application/vnd.observable.javascript" name="count">count = rows.length</script>
  <script id="3" type="application/vnd.observable.javascript" name="attachmentUrl">attachmentUrl = FileAttachment("points.csv").url()</script>
</notebook>
`,
			attachments: {
				"points.csv": { url: "https://static.example/points.csv", mimeType: "text/csv" },
			},
			_variables: { rows: [{ x: 10 }, { x: 20 }], unused: 1 },
			options: {},
			_cell_widgets: ["anywidget:rows", "anywidget:count", "anywidget:attachment"],
		});
		const childModels = new Map([
			["anywidget:rows", createModel({ role: "cell", name: "rows", _values: {}, _value_names: [] })],
			["anywidget:count", createModel({ role: "cell", name: "count", _values: {}, _value_names: [] })],
			["anywidget:attachment", createModel({ role: "cell", name: "attachmentUrl", _values: {}, _value_names: [] })],
		]);
		const controller = new AbortController();

		widget.render({
			model,
			el: document.createElement("div"),
			signal: controller.signal,
			host: createHost(childModels, createCellExportsMap(childModels), renderChildrenThroughWidget(childModels)),
		} as unknown as RenderProps<WidgetModel>);

		expect(await waitFor(() => (variableValue(model, "count") === 2 ? 2 : undefined))).toBe(2);
		expect(await waitFor(() => variableValue(model, "rows") as Array<{ x: number }> | undefined)).toEqual([
			{ x: 10 },
			{ x: 20 },
		]);
		expect(await waitFor(() => variableValue(model, "attachmentUrl") as string | undefined)).toBe(
			"https://static.example/points.csv",
		);
		controller.abort();
	});

	test("syncs graph metadata for source-backed Notebook Kit HTML", async () => {
		const model = createModel({
			role: "notebook",
			source: `
<notebook>
  <script id="1" type="application/vnd.observable.javascript" name="answer">answer = 42</script>
  <script id="2" type="module" name="double">const double = answer * 2;</script>
</notebook>
`,
			attachments: {},
			_variables: {},
			options: {},
			_cell_widgets: ["anywidget:source-1", "anywidget:source-2"],
		});
		const childModels = new Map([
			["anywidget:source-1", createModel({ role: "cell", name: "answer", _values: {}, _value_names: [] })],
			["anywidget:source-2", createModel({ role: "cell", name: "double", _values: {}, _value_names: [] })],
		]);
		const controller = new AbortController();

		widget.render({
			model,
			el: document.createElement("div"),
			signal: controller.signal,
			host: createHost(childModels),
		} as unknown as RenderProps<WidgetModel>);

		const graph = await waitFor(() => model.get("_graph") as NotebookGraph | undefined);

		expect(graph.cells.map((cell) => cell.id)).toEqual([1, 2]);
		expect(graph.cells.map((cell) => cell.name)).toEqual(["answer", "double"]);
		expect(graph.cells[1]?.defines).toEqual(["double"]);
		expect(graph.cells[1]?.references).toEqual(["answer"]);
		expect(graph.edges).toEqual([{ from: 1, to: 2, variable: "answer" }]);
		controller.abort();
	});

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

		const cell = await waitFor(() => el.querySelector(`${SELECTORS.composedCell} .observablehq--cell`) ?? undefined);
		expect(cell.id).toBe("cell-1");
		controller.abort();
	});

	test("renders pinned source chrome below the cell output", async () => {
		const source = "answer = 42";
		const model = createModel({
			role: "notebook",
			spec: { cells: [{ id: 1, mode: "ojs", value: source, pinned: true }] },
			attachments: {},
			_variables: {},
			options: { show_source: true },
			_cell_widgets: ["anywidget:answer"],
		});
		const childModels = new Map([
			["anywidget:answer", createModel({ role: "cell", name: "answer", _values: {}, _value_names: [] })],
		]);
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: createHost(childModels, createCellExportsMap(childModels), renderChildrenThroughWidget(childModels)),
		} as unknown as RenderProps<WidgetModel>);

		const wrapper = await waitFor(() => el.querySelector<HTMLElement>(SELECTORS.composedCell) ?? undefined);
		await waitFor(() => wrapper.querySelector(SELECTORS.sourcePanel) ?? undefined);
		const children = Array.from(wrapper.children);
		const panel = wrapper.querySelector<HTMLElement>(SELECTORS.sourcePanel);
		const pre = panel?.querySelector<HTMLPreElement>(SELECTORS.source);
		const label = panel?.querySelector<HTMLElement>(SELECTORS.sourceLabel);

		expect(children[0]?.classList.contains("observablehq--cell")).toBe(true);
		expect(children[1]).toBe(panel);
		expect(panel?.querySelector(SELECTORS.sourceHeader)).toBeNull();
		expect(pre?.textContent).toBe(source);
		expect(pre?.nextElementSibling).toBe(label);
		expect(pre?.contains(label ?? null)).toBe(false);
		expect(pre?.getAttribute("aria-label")).toBe("OJS source");
		expect(label?.textContent).toBe("OJS");
		controller.abort();
	});

	test("renders composed cells through widget_manager when host is absent", async () => {
		const childModel = createModel({
			role: "cell",
			name: "answer",
			_values: {},
			_value_names: [],
		});
		const childModels = new Map([["answer", childModel]]);
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
				get_model: async (modelId: string) => childModels.get(modelId),
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

		const cell = await waitFor(() => el.querySelector(`${SELECTORS.composedCell} .observablehq--cell`) ?? undefined);
		expect(cell.id).toBe("cell-1");
		controller.abort();
	});

	test("cleans signal-scoped child listeners when composed child render fails", async () => {
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
		const events: string[] = [];
		const childExports = new Map([
			["anywidget:answer", trackingCellExports("answer", events)],
			["anywidget:broken", trackingCellExports("broken", events)],
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
			host: createHost(childModels, childExports, childRenders),
		} as unknown as RenderProps<WidgetModel>);

		await waitFor(() => el.querySelector(SELECTORS.error) ?? undefined);

		expect(events).toContain("unbind:answer");
		expect(events).toContain("unbind:broken");
		for (const childModel of childModels.values()) {
			expect(childModel.listenerCount("change:_values")).toBe(0);
			expect(childModel.listenerCount("change:_value_names")).toBe(0);
		}
	});

	test("does not register notebook listeners when render signal is already aborted", () => {
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

		widget.render({
			model,
			el: document.createElement("div"),
			signal: controller.signal,
			host: createHost(new Map()),
		} as unknown as RenderProps<WidgetModel>);

		expect(model.listenerCount("change:spec")).toBe(0);
		expect(model.listenerCount("change:_cell_widgets")).toBe(0);
	});

	test("cleans isolated standalone dependency listeners when dependency setup fails", async () => {
		const model = createModel({ role: "cell", name: "target", _values: {}, _value_names: [] });
		const siblingModel = createModel({
			role: "cell",
			name: "a",
			_values: { a: 1 },
			_value_names: ["a"],
		});
		const badSiblingModel = createModel({
			role: "cell",
			name: "b",
			_values: {},
			_value_names: [],
		});
		const notebook = toNotebook({
			cells: [
				{ id: 1, mode: "ojs", value: "a = 1" },
				{ id: 2, mode: "ojs", value: "b =" },
				{ id: 3, mode: "ojs", value: "viewof target = Inputs.range([a, b])" },
			],
		});
		const graph: NotebookGraph = {
			cells: [
				{
					id: 1,
					index: 0,
					name: "a",
					mode: "ojs",
					defines: ["a"],
					references: [],
					output: "a",
					outputs: [],
					runtime_outputs: ["a"],
					autodisplay: false,
					autoview: false,
					automutable: false,
				},
				{
					id: 2,
					index: 1,
					name: "b",
					mode: "ojs",
					defines: ["b"],
					references: [],
					output: "b",
					outputs: [],
					runtime_outputs: ["b"],
					autodisplay: false,
					autoview: false,
					automutable: false,
				},
				{
					id: 3,
					index: 2,
					name: "target",
					mode: "ojs",
					defines: ["target", "viewof target"],
					references: ["a", "b", "Inputs"],
					output: "viewof target",
					outputs: [],
					runtime_outputs: ["target", "viewof target"],
					autodisplay: false,
					autoview: true,
					automutable: false,
				},
			],
			edges: [
				{ from: 0, to: 2, variable: "a" },
				{ from: 1, to: 2, variable: "b" },
			],
		};
		const exports = createCellExports(model);
		exports.bindRuntime({
			notebookModel: createModel({ role: "notebook", _graph: graph, _variables: {}, _values: {}, _value_names: [] }),
			runtime: {} as CellRenderContext["runtime"],
			showSource: false,
			cell: notebook.cells[2],
			cellIndex: 2,
			notebook,
			options: { attachments: {}, baseUrl: document.baseURI, variables: {}, showSource: false },
			cellModels: [siblingModel, badSiblingModel, model],
			sync: {} as CellRenderContext["sync"],
		});

		const el = document.createElement("div");
		widget.render({
			model,
			el,
			signal: new AbortController().signal,
			host: createHost(new Map()),
		} as unknown as RenderProps<WidgetModel>);

		await waitFor(() => el.querySelector(SELECTORS.error) ?? undefined);
		expect(siblingModel.listenerCount("change:_values")).toBe(0);
	});

	test("standalone source cells use live notebook runtime dependencies", async () => {
		const model = createModel({
			role: "notebook",
			source: `
<notebook>
  <script id="2" type="module">svg.node()</script>
  <script id="1" type="module" pinned>const svg = ({node: () => "live-svg"});</script>
</notebook>
`,
			attachments: {},
			_variables: {},
			options: {},
			_cell_widgets: ["anywidget:display", "anywidget:source"],
		});
		const displayModel = createModel({
			role: "cell",
			_cell_id: "display-cell",
			name: "display",
			_values: {},
			_value_names: [],
		});
		const sourceModel = createModel({
			role: "cell",
			_cell_id: "source-cell",
			name: "source",
			_values: {},
			_value_names: [],
		});
		const childModels = new Map([
			["anywidget:display", displayModel],
			["anywidget:source", sourceModel],
		]);
		const childExports = new Map([
			["anywidget:display", createCellExports(displayModel)],
			["anywidget:source", createCellExports(sourceModel)],
		]);
		const childRenders = new Map<string, ChildRender>();
		for (const [ref, childModel] of childModels) {
			childRenders.set(ref, ({ el, signal }) => {
				widget.render({
					model: childModel,
					el,
					signal: signal ?? new AbortController().signal,
					host: createHost(new Map()),
				} as unknown as RenderProps<WidgetModel>);
			});
		}
		const parentEl = document.createElement("div");
		const controller = new AbortController();

		widget.render({
			model,
			el: parentEl,
			signal: controller.signal,
			host: createHost(childModels, childExports, childRenders),
		} as unknown as RenderProps<WidgetModel>);
		await waitFor(() => parentEl.querySelector("#cell-2") ?? undefined);

		const standaloneEl = document.createElement("div");
		widget.render({
			model: displayModel,
			el: standaloneEl,
			signal: controller.signal,
			host: createHost(new Map()),
		} as unknown as RenderProps<WidgetModel>);

		await waitFor(() => (standaloneEl.textContent?.includes("live-svg") ? standaloneEl : undefined));
		expect(standaloneEl.querySelector(`${SELECTORS.standaloneCell} #cell-2`)).not.toBeNull();
		controller.abort();
	});

	test("standalone viewof cells evaluate function dependencies from notebook source", async () => {
		const model = createModel({
			role: "notebook",
			spec: {
				cells: [
					{
						id: 1,
						mode: "ojs",
						value: `
Select = (items, options = {}) => {
  const select = document.createElement("select");
  for (const item of items) {
    const option = document.createElement("option");
    option.value = item;
    option.textContent = item;
    select.appendChild(option);
  }
  select.value = options.value ?? items[0];
  return select;
}`,
					},
					{ id: 2, mode: "ojs", value: 'items = ["one", "two"]' },
					{ id: 3, mode: "ojs", value: 'viewof choice = Select(items, {value: "two"})' },
				],
			},
			attachments: {},
			_variables: {},
			options: {},
			_cell_widgets: ["anywidget:select", "anywidget:items", "anywidget:choice"],
		});
		const selectModel = createModel({ role: "cell", name: "select", _values: {}, _value_names: [] });
		const itemsModel = createModel({ role: "cell", name: "items", _values: {}, _value_names: [] });
		const choiceModel = createModel({ role: "cell", name: "choice", _values: {}, _value_names: [] });
		const childModels = new Map([
			["anywidget:select", selectModel],
			["anywidget:items", itemsModel],
			["anywidget:choice", choiceModel],
		]);
		const childExports = createCellExportsMap(childModels);
		const childRenders = renderChildrenThroughWidget(childModels);
		const parentEl = document.createElement("div");
		const controller = new AbortController();

		widget.render({
			model,
			el: parentEl,
			signal: controller.signal,
			host: createHost(childModels, childExports, childRenders),
		} as unknown as RenderProps<WidgetModel>);
		await waitFor(() => (variableValue(choiceModel, "choice") === "two" ? "two" : undefined));

		const standaloneEl = document.createElement("div");
		widget.render({
			model: choiceModel,
			el: standaloneEl,
			signal: controller.signal,
			host: createHost(new Map()),
		} as unknown as RenderProps<WidgetModel>);

		const select = await waitFor(() => {
			const error = standaloneEl.querySelector(SELECTORS.error)?.textContent;
			if (error) throw new Error(error);
			return standaloneEl.querySelector<HTMLSelectElement>("select") ?? undefined;
		});

		expect(select.value).toBe("two");
		expect(standaloneEl.querySelector(`${SELECTORS.standaloneCell} select`)).not.toBeNull();
		controller.abort();
	});

	test("standalone cells render after the composed Observable-shaped notebook", async () => {
		const model = createModel({
			role: "notebook",
			spec: {
				cells: [
					{ id: 1, mode: "md", value: "# Voronoi Spirals II" },
					{ id: 2, mode: "md", value: "Adapted from original work." },
					{ id: 3, mode: "ojs", value: 'viewof choice = Select(items, {value: "two"})' },
					{ id: 4, mode: "ojs", value: 'items = ["one", "two"]' },
					{
						id: 5,
						mode: "ojs",
						value: `
Select = (items, options = {}) => {
  const select = document.createElement("select");
  for (const item of items) {
    const option = document.createElement("option");
    option.value = item;
    option.textContent = item;
    select.appendChild(option);
  }
  select.value = options.value ?? items[0];
  return select;
}`,
					},
				],
			},
			attachments: {},
			_variables: {},
			options: {},
			_cell_widgets: [
				"anywidget:title",
				"anywidget:caption",
				"anywidget:choice",
				"anywidget:items",
				"anywidget:select",
			],
		});
		const titleModel = createModel({ role: "cell", name: "title", _values: {}, _value_names: [] });
		const captionModel = createModel({ role: "cell", name: "caption", _values: {}, _value_names: [] });
		const choiceModel = createModel({ role: "cell", name: "choice", _values: {}, _value_names: [] });
		const itemsModel = createModel({ role: "cell", name: "items", _values: {}, _value_names: [] });
		const selectModel = createModel({ role: "cell", name: "select", _values: {}, _value_names: [] });
		const childModels = new Map([
			["anywidget:title", titleModel],
			["anywidget:caption", captionModel],
			["anywidget:choice", choiceModel],
			["anywidget:items", itemsModel],
			["anywidget:select", selectModel],
		]);
		const childExports = createCellExportsMap(childModels);
		const childRenders = renderChildrenThroughWidget(childModels);
		const parentEl = document.createElement("div");
		const controller = new AbortController();

		widget.render({
			model,
			el: parentEl,
			signal: controller.signal,
			host: createHost(childModels, childExports, childRenders),
		} as unknown as RenderProps<WidgetModel>);
		await waitFor(() => (variableValue(choiceModel, "choice") === "two" ? "two" : undefined));

		const titleEl = document.createElement("div");
		widget.render({
			model: titleModel,
			el: titleEl,
			signal: controller.signal,
			host: createHost(new Map()),
		} as unknown as RenderProps<WidgetModel>);
		await waitFor(() => (titleEl.textContent?.includes("Voronoi Spirals II") ? titleEl : undefined));

		const choiceEl = document.createElement("div");
		widget.render({
			model: choiceModel,
			el: choiceEl,
			signal: controller.signal,
			host: createHost(new Map()),
		} as unknown as RenderProps<WidgetModel>);
		const select = await waitFor(() => {
			const error = choiceEl.querySelector(SELECTORS.error)?.textContent;
			if (error) throw new Error(error);
			return choiceEl.querySelector<HTMLSelectElement>("select") ?? undefined;
		});

		expect(select.value).toBe("two");
		controller.abort();
	});

	test("standalone viewof cells resolve runtime-output dependencies that appear after the target", async () => {
		const model = createModel({
			role: "notebook",
			spec: {
				cells: [
					{ id: 1, mode: "ojs", value: 'viewof choice = Select(items, {value: "two"})' },
					{ id: 2, mode: "ojs", value: 'items = ["one", "two"]' },
					{
						id: 3,
						mode: "ojs",
						value: `
Select = (items, options = {}) => {
  const select = document.createElement("select");
  for (const item of items) {
    const option = document.createElement("option");
    option.value = item;
    option.textContent = item;
    select.appendChild(option);
  }
  select.value = options.value ?? items[0];
  return select;
}`,
					},
				],
			},
			attachments: {},
			_variables: {},
			_graph: {
				cells: [
					{
						id: 1,
						index: 0,
						name: "choice",
						mode: "ojs",
						defines: ["choice", "viewof choice"],
						references: ["Select", "items"],
						output: "viewof choice",
						outputs: [],
						runtime_outputs: ["choice", "viewof choice"],
						autodisplay: false,
						autoview: true,
						automutable: false,
					},
					{
						id: 2,
						index: 1,
						name: "items",
						mode: "ojs",
						defines: ["items"],
						references: [],
						output: "items",
						outputs: [],
						runtime_outputs: ["items"],
						autodisplay: false,
						autoview: false,
						automutable: false,
					},
					{
						id: 3,
						index: 2,
						name: "Select",
						mode: "ojs",
						defines: [],
						references: [],
						output: null,
						outputs: ["Select"],
						runtime_outputs: ["Select"],
						autodisplay: false,
						autoview: false,
						automutable: false,
					},
				],
				edges: [
					{ from: 1, to: 0, variable: "items" },
					{ from: 2, to: 0, variable: "Select" },
				],
			},
			options: {},
			_cell_widgets: ["anywidget:choice", "anywidget:items", "anywidget:select"],
		});
		const choiceModel = createModel({ role: "cell", name: "choice", _values: {}, _value_names: [] });
		const itemsModel = createModel({ role: "cell", name: "items", _values: {}, _value_names: [] });
		const selectModel = createModel({ role: "cell", name: "select", _values: {}, _value_names: [] });
		const childModels = new Map([
			["anywidget:choice", choiceModel],
			["anywidget:items", itemsModel],
			["anywidget:select", selectModel],
		]);
		const childExports = createCellExportsMap(childModels);
		const childRenders = renderChildrenThroughWidget(childModels);
		const parentEl = document.createElement("div");
		const controller = new AbortController();

		widget.render({
			model,
			el: parentEl,
			signal: controller.signal,
			host: createHost(childModels, childExports, childRenders),
		} as unknown as RenderProps<WidgetModel>);
		await waitFor(() => (variableValue(choiceModel, "choice") === "two" ? "two" : undefined));

		const standaloneEl = document.createElement("div");
		widget.render({
			model: choiceModel,
			el: standaloneEl,
			signal: controller.signal,
			host: createHost(new Map()),
		} as unknown as RenderProps<WidgetModel>);

		const select = await waitFor(() => {
			const error = standaloneEl.querySelector(SELECTORS.error)?.textContent;
			if (error) throw new Error(error);
			return standaloneEl.querySelector<HTMLSelectElement>("select") ?? undefined;
		});

		expect(select.value).toBe("two");
		select.value = "one";
		select.dispatchEvent(new Event("input", { bubbles: true }));
		select.dispatchEvent(new Event("change", { bubbles: true }));
		await waitFor(() => (variableValue(choiceModel, "choice") === "one" ? "one" : undefined));
		controller.abort();
	});

	test("standalone dependencies avoid duplicate names when live and source outputs share a cell", async () => {
		const model = createModel({
			role: "notebook",
			spec: {
				cells: [
					{
						id: 1,
						mode: "ojs",
						value: `
makeInput = (value) => {
  const input = document.createElement("input");
  input.value = value;
  return input;
}`,
					},
					{ id: 2, mode: "ojs", value: 'viewof x = makeInput("source")' },
					{
						id: 3,
						mode: "ojs",
						value: `
viewof target = {
  const input = document.createElement("input");
  input.value = \`\${viewof x.value}:\${x}\`;
  return input;
}`,
					},
				],
			},
			attachments: {},
			_variables: {},
			options: {},
			_cell_widgets: ["anywidget:make-input", "anywidget:x", "anywidget:target"],
		});
		const makeInputModel = createModel({ role: "cell", name: "makeInput", _values: {}, _value_names: [] });
		const xModel = createModel({ role: "cell", name: "x", _values: {}, _value_names: [] });
		const targetModel = createModel({ role: "cell", name: "target", _values: {}, _value_names: [] });
		const childModels = new Map([
			["anywidget:make-input", makeInputModel],
			["anywidget:x", xModel],
			["anywidget:target", targetModel],
		]);
		const childExports = createCellExportsMap(childModels);
		const childRenders = renderChildrenThroughWidget(childModels);
		const parentEl = document.createElement("div");
		const controller = new AbortController();

		widget.render({
			model,
			el: parentEl,
			signal: controller.signal,
			host: createHost(childModels, childExports, childRenders),
		} as unknown as RenderProps<WidgetModel>);
		await waitFor(() => (variableValue(xModel, "x") === "source" ? "source" : undefined));
		xModel.set("_values", { x: "live" });
		targetModel.set("_values", {});

		const standaloneEl = document.createElement("div");
		widget.render({
			model: targetModel,
			el: standaloneEl,
			signal: controller.signal,
			host: createHost(new Map()),
		} as unknown as RenderProps<WidgetModel>);

		const input = await waitFor(() => {
			const error = standaloneEl.querySelector(SELECTORS.error)?.textContent;
			if (error) throw new Error(error);
			const candidate = standaloneEl.querySelector<HTMLInputElement>("input");
			return candidate?.value === "live:live" ? candidate : undefined;
		});
		expect(input.value).toBe("live:live");
		expect(xModel.listenerCount("change:_values")).toBeGreaterThan(0);
		controller.abort();
		expect(xModel.listenerCount("change:_values")).toBe(0);
	});

	test("standalone dependencies define mutable companions when live values collide", async () => {
		const model = createModel({
			role: "notebook",
			spec: {
				cells: [
					{
						id: 1,
						mode: "ojs",
						value: `
makeInput = (value) => {
  const input = document.createElement("input");
  input.value = value;
  return input;
}`,
					},
					{ id: 2, mode: "ojs", value: "mutable x = 1" },
					{ id: 3, mode: "ojs", value: 'viewof target = makeInput([mutable x, x].join(":"))' },
				],
			},
			attachments: {},
			_variables: {},
			options: {},
			_cell_widgets: ["anywidget:make-input", "anywidget:x", "anywidget:target"],
		});
		const makeInputModel = createModel({ role: "cell", name: "makeInput", _values: {}, _value_names: [] });
		const xModel = createModel({ role: "cell", name: "x", _values: {}, _value_names: [] });
		const targetModel = createModel({ role: "cell", name: "target", _values: {}, _value_names: [] });
		const childModels = new Map([
			["anywidget:make-input", makeInputModel],
			["anywidget:x", xModel],
			["anywidget:target", targetModel],
		]);
		const childExports = createCellExportsMap(childModels);
		const childRenders = renderChildrenThroughWidget(childModels);
		const parentEl = document.createElement("div");
		const controller = new AbortController();

		widget.render({
			model,
			el: parentEl,
			signal: controller.signal,
			host: createHost(childModels, childExports, childRenders),
		} as unknown as RenderProps<WidgetModel>);
		await waitFor(() => (variableValue(xModel, "x") === 1 ? 1 : undefined));
		xModel.set("_values", { x: 5 });
		targetModel.set("_values", {});

		const standaloneEl = document.createElement("div");
		widget.render({
			model: targetModel,
			el: standaloneEl,
			signal: controller.signal,
			host: createHost(new Map()),
		} as unknown as RenderProps<WidgetModel>);

		await waitFor(() => {
			const error = standaloneEl.querySelector(SELECTORS.error)?.textContent;
			if (error) throw new Error(error);
			const candidate = standaloneEl.querySelector<HTMLInputElement>("input");
			return candidate?.value === "1:5" ? candidate : undefined;
		});
		controller.abort();
	});

	test("standalone viewof dependencies prefer live sibling values when they are revivable", async () => {
		const model = createModel({
			role: "notebook",
			spec: {
				cells: [
					{
						id: 1,
						mode: "ojs",
						value: `
Select = (items, options = {}) => {
  const picker = document.createElement("button");
  picker.dataset.role = "preset-picker";
  let selected = options.value ?? items[0];
  const paint = () => {
    picker.textContent = String(items.indexOf(selected) + 1);
    picker.dataset.index = String(items.indexOf(selected));
  };
  Object.defineProperty(picker, "value", {
    get() { return selected; },
    set(value) {
      selected = value;
      paint();
    },
  });
  paint();
  return picker;
}`,
					},
					{
						id: 2,
						mode: "ojs",
						value: `
Range = ([start], options = {}) => {
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(start);
  input.max = "500";
  input.value = String(options.value ?? start);
  return input;
}`,
					},
					{
						id: 3,
						mode: "ojs",
						value: "presetsArray = [{pointDensity: 7}, {pointDensity: 21}]",
					},
					{
						id: 4,
						mode: "ojs",
						value: "viewof presets = Select(presetsArray, {value: presetsArray[0]})",
					},
					{
						id: 5,
						mode: "ojs",
						value: "viewof pointDensity = Range([3, 500], {value: presets.pointDensity})",
					},
				],
			},
			attachments: {},
			_variables: {},
			options: {},
			_cell_widgets: [
				"anywidget:select",
				"anywidget:range",
				"anywidget:presets-array",
				"anywidget:presets",
				"anywidget:point-density",
			],
		});
		const selectModel = createModel({ role: "cell", name: "select", _values: {}, _value_names: [] });
		const rangeModel = createModel({ role: "cell", name: "range", _values: {}, _value_names: [] });
		const presetsArrayModel = createModel({ role: "cell", name: "presetsArray", _values: {}, _value_names: [] });
		const presetsModel = createModel({ role: "cell", name: "presets", _values: {}, _value_names: [] });
		const pointDensityModel = createModel({ role: "cell", name: "pointDensity", _values: {}, _value_names: [] });
		const childModels = new Map([
			["anywidget:select", selectModel],
			["anywidget:range", rangeModel],
			["anywidget:presets-array", presetsArrayModel],
			["anywidget:presets", presetsModel],
			["anywidget:point-density", pointDensityModel],
		]);
		const childExports = createCellExportsMap(childModels);
		const childRenders = renderChildrenThroughWidget(childModels);
		const parentEl = document.createElement("div");
		const controller = new AbortController();

		widget.render({
			model,
			el: parentEl,
			signal: controller.signal,
			host: createHost(childModels, childExports, childRenders),
		} as unknown as RenderProps<WidgetModel>);

		const parentPicker = await waitFor(
			() => parentEl.querySelector<HTMLButtonElement>("button[data-role='preset-picker']") ?? undefined,
		);
		(parentPicker as unknown as { value: { pointDensity: number } }).value = { pointDensity: 21 };
		parentPicker.click();
		await waitFor(() => {
			const value = variableValue(presetsModel, "presets");
			return value && typeof value === "object" && (value as { pointDensity?: unknown }).pointDensity === 21
				? value
				: undefined;
		});
		pointDensityModel.set("_values", {});

		const standaloneEl = document.createElement("div");
		widget.render({
			model: pointDensityModel,
			el: standaloneEl,
			signal: controller.signal,
			host: createHost(new Map()),
		} as unknown as RenderProps<WidgetModel>);

		const input = await waitFor(() => {
			const error = standaloneEl.querySelector(SELECTORS.error)?.textContent;
			if (error) throw new Error(error);
			const candidate = standaloneEl.querySelector<HTMLInputElement>("input[type='range']");
			return candidate?.valueAsNumber === 21 ? candidate : undefined;
		});

		expect(input.valueAsNumber).toBe(21);
		controller.abort();
	});

	test("standalone dependency resolution ignores malformed unrelated cells", async () => {
		const model = createModel({
			role: "notebook",
			spec: {
				cells: [
					{ id: 1, mode: "ojs", value: "bad =" },
					{ id: 2, mode: "ojs", value: 'message = "ready"' },
					{ id: 3, mode: "ojs", value: "message" },
				],
			},
			attachments: {},
			_variables: {},
			options: {},
			_cell_widgets: ["anywidget:bad", "anywidget:message", "anywidget:display"],
		});
		const badModel = createModel({ role: "cell", name: "bad", _values: {}, _value_names: [] });
		const messageModel = createModel({ role: "cell", name: "message", _values: {}, _value_names: [] });
		const displayModel = createModel({ role: "cell", name: "display", _values: {}, _value_names: [] });
		const childModels = new Map([
			["anywidget:bad", badModel],
			["anywidget:message", messageModel],
			["anywidget:display", displayModel],
		]);
		const childExports = createCellExportsMap(childModels);
		const childRenders = renderChildrenThroughWidget(childModels);
		const parentEl = document.createElement("div");
		const controller = new AbortController();

		widget.render({
			model,
			el: parentEl,
			signal: controller.signal,
			host: createHost(childModels, childExports, childRenders),
		} as unknown as RenderProps<WidgetModel>);
		await waitFor(() => (variableValue(messageModel, "message") === "ready" ? "ready" : undefined));

		const standaloneEl = document.createElement("div");
		widget.render({
			model: displayModel,
			el: standaloneEl,
			signal: controller.signal,
			host: createHost(new Map()),
		} as unknown as RenderProps<WidgetModel>);

		await waitFor(() => (standaloneEl.textContent?.includes("ready") ? standaloneEl : undefined));
		expect(standaloneEl.querySelector(SELECTORS.error)).toBeNull();
		controller.abort();
	});
});
