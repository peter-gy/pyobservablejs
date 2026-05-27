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
		const exports = createCellExports(model);
		exports.bindRuntime({
			notebookModel: createModel({ role: "notebook", _variables: {}, _values: {}, _value_names: [] }),
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
});
