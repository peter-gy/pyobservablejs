// @vitest-environment jsdom

import type { RenderProps } from "@anywidget/types";
import { toNotebook, type CellSpec } from "@observablehq/notebook-kit";
import { describe, expect, test } from "vitest";
import { SELECTORS } from "./dom-contract";
import { createNotebookGraph } from "./graph";
import type { CellRenderContext, NotebookGraph, WidgetModel } from "./types";
import widget from "./widget";
import {
	type ChildRender,
	createCellExports,
	createCellExportsMap,
	createHost,
	createModel,
	objectValuedSelectSource,
	renderChildrenThroughWidget,
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
		expect(graph.edges).toHaveLength(1);
		expect(graph.edges).toContainEqual({ from: 1, to: 2, variable: "answer" });
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

		expect(changedGain).toBe(7.5);
		expect(await waitFor(() => (variableValue(model, "readout") === 15 ? 15 : undefined))).toBe(15);
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

		await waitFor(() => standaloneText(standaloneEl, "41"));
		controller.abort();
	});

	test("standalone transitive dependencies keep Python variables ahead of sibling cells", async () => {
		const model = createModel({
			role: "notebook",
			spec: {
				cells: [
					{ id: 1, mode: "ojs", value: "seed = 1" },
					{ id: 2, mode: "ojs", value: "middle = seed * 2" },
					{ id: 3, mode: "ojs", value: "target = middle + 1" },
				],
			},
			attachments: {},
			_variables: { seed: 10 },
			options: {},
			_cell_widgets: ["anywidget:seed", "anywidget:middle", "anywidget:target"],
		});
		const seedModel = createModel({ role: "cell", name: "seed", _values: {}, _value_names: [] });
		const middleModel = createModel({ role: "cell", name: "middle", _values: {}, _value_names: [] });
		const targetModel = createModel({ role: "cell", name: "target", _values: {}, _value_names: [] });
		const childModels = new Map([
			["anywidget:seed", seedModel],
			["anywidget:middle", middleModel],
			["anywidget:target", targetModel],
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

		expect(await waitFor(() => (variableValue(targetModel, "target") === 21 ? 21 : undefined))).toBe(21);
		seedModel.set("_values", { seed: 1 });
		seedModel.set("_value_names", ["seed"]);
		middleModel.set("_values", {});
		targetModel.set("_values", {});

		const standaloneEl = document.createElement("div");
		widget.render({
			model: targetModel,
			el: standaloneEl,
			signal: controller.signal,
			host: createHost(new Map()),
		} as unknown as RenderProps<WidgetModel>);

		await waitFor(() => standaloneText(standaloneEl, "21"));
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
		expect(graph.edges).toHaveLength(1);
		expect(graph.edges).toContainEqual({ from: 1, to: 2, variable: "answer" });
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

		await waitStep("composed output", () => composedText(el, "42"));
		controller.abort();
	});

	test("renders pinned source chrome for cell output", async () => {
		const source = "answer = 42";
		const answerModel = createModel({ role: "cell", name: "answer", _values: {}, _value_names: [] });
		const model = createModel({
			role: "notebook",
			spec: { cells: [{ id: 1, mode: "ojs", value: source, pinned: true }] },
			attachments: {},
			_variables: {},
			options: { show_source: true },
			_cell_widgets: ["anywidget:answer"],
		});
		const childModels = new Map([["anywidget:answer", answerModel]]);
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: createHost(childModels, createCellExportsMap(childModels), renderChildrenThroughWidget(childModels)),
		} as unknown as RenderProps<WidgetModel>);

		const wrapper = await waitFor(() => el.querySelector<HTMLElement>(SELECTORS.composedCell) ?? undefined);
		await waitStep("pinned source output", () => (variableValue(answerModel, "answer") === 42 ? 42 : undefined));
		const sourceBlock = await waitFor(
			() => wrapper.querySelector<HTMLPreElement>("pre[aria-label='OJS source']") ?? undefined,
		);

		expect(sourceBlock.textContent).toBe(source);
		expect(sourceBlock.getAttribute("aria-label")).toBe("OJS source");
		controller.abort();
	});

	test("renders composed cells through widget_manager when host is absent", async () => {
		let rejectedOnce = false;
		const resolvedModels: Array<ReturnType<typeof createModel>> = [];
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
				get_model: async (modelId: string) => {
					if (modelId !== "answer") return undefined;
					if (!rejectedOnce) {
						rejectedOnce = true;
						throw new Error("not ready");
					}
					const childModel = createModel({
						role: "cell",
						name: "answer",
						_values: {},
						_value_names: [],
					});
					resolvedModels.push(childModel);
					return childModel;
				},
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

		await waitStep("fallback composed output", () => composedText(el, "42"));
		expect(await waitFor(() => (variableValue(model, "answer") === 42 ? 42 : undefined))).toBe(42);
		const renderedModel = resolvedModels.find((childModel) => variableValue(childModel, "answer") === 42);
		if (!renderedModel) throw new Error("Expected the fallback widget manager to render a resolved child model");

		const standaloneEl = document.createElement("div");
		widget.render({
			model: renderedModel,
			el: standaloneEl,
			signal: controller.signal,
			host: undefined,
		} as unknown as RenderProps<WidgetModel>);

		await waitFor(() => standaloneText(standaloneEl, "42"));
		controller.abort();
	});

	test("child render failure ignores later child updates", async () => {
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
			host: createHost(childModels, createCellExportsMap(childModels), childRenders),
		} as unknown as RenderProps<WidgetModel>);

		await waitFor(() => projectErrorText(el));

		for (const childModel of childModels.values()) childModel.set("_values", { leaked: true });
		expect(variableValue(model, "leaked")).toBeUndefined();
	});

	test("aborted render ignores later model changes", () => {
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
		const el = document.createElement("div");

		widget.render({
			model,
			el,
			signal: controller.signal,
			host: createHost(new Map()),
		} as unknown as RenderProps<WidgetModel>);

		model.set("spec", { cells: [{ id: 1, mode: "ojs", value: "answer = 42" }] });
		model.set("_cell_widgets", ["anywidget:answer"]);
		expect(el.childElementCount).toBe(0);
	});

	test("dependency setup errors recover after dependency values arrive", async () => {
		const model = createModel({ role: "cell", name: "target", _values: {}, _value_names: [] });
		const siblingModel = createModel({
			role: "cell",
			name: "a",
			_values: { a: 1 },
			_value_names: ["a"],
		});
		const pendingSiblingModel = createModel({
			role: "cell",
			name: "b",
			_values: {},
			_value_names: [],
		});
		const notebook = toNotebook({
			cells: [
				{ id: 1, mode: "ojs", value: "a = 1" },
				{ id: 2, mode: "js", value: "const b = 3;" },
				{ id: 3, mode: "ojs", value: "target = a + b" },
			],
		});
		const graph = createNotebookGraph(notebook, ["a", "b", "target"]);
		const exports = createCellExports(model);
		exports.bindRuntime({
			notebookModel: createModel({ role: "notebook", _graph: graph, _variables: {}, _values: {}, _value_names: [] }),
			runtime: {} as CellRenderContext["runtime"],
			showSource: false,
			cell: notebook.cells[2],
			cellIndex: 2,
			notebook,
			options: {
				attachments: {},
				baseUrl: document.baseURI,
				variables: {},
				showSource: false,
				observableMarkdownCompatibility: false,
			},
			cellModels: [siblingModel, pendingSiblingModel, model],
			sync: {} as CellRenderContext["sync"],
		});

		const el = document.createElement("div");
		widget.render({
			model,
			el,
			signal: new AbortController().signal,
			host: createHost(new Map()),
		} as unknown as RenderProps<WidgetModel>);

		await waitFor(() => el.querySelector<HTMLElement>(SELECTORS.standaloneCell) ?? undefined, 3000);
		siblingModel.set("_values", { a: 2 });
		pendingSiblingModel.set("_values", { b: 3 });
		pendingSiblingModel.set("_value_names", ["b"]);
		await waitFor(() => standaloneInspectorText(el, "5"), 3000);
	});

	test("standalone source OJS cells rebuild dependency cells", async () => {
		const model = createModel({
			role: "notebook",
			source: `
<notebook>
  <script id="1" type="application/vnd.observable.javascript" pinned>svg = ({node: () => "live-svg"})</script>
  <script id="2" type="application/vnd.observable.javascript">svg.node()</script>
</notebook>
`,
			attachments: {},
			_variables: {},
			options: {},
			_cell_widgets: ["anywidget:source", "anywidget:display"],
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
			["anywidget:source", sourceModel],
			["anywidget:display", displayModel],
		]);
		const childExports = new Map([
			["anywidget:source", createCellExports(sourceModel)],
			["anywidget:display", createCellExports(displayModel)],
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
		await waitFor(() => composedInspectorText(parentEl, "live-svg"));

		const standaloneEl = document.createElement("div");
		widget.render({
			model: displayModel,
			el: standaloneEl,
			signal: controller.signal,
			host: createHost(new Map()),
		} as unknown as RenderProps<WidgetModel>);

		await waitFor(() => {
			const error = standaloneEl.querySelector(SELECTORS.error)?.textContent;
			if (error) throw new Error(error);
			return standaloneInspectorText(standaloneEl, "live-svg");
		});
		controller.abort();
	});

	test("standalone source-backed sibling cells render their own output", async () => {
		const model = createModel({
			role: "notebook",
			source: `
	<notebook>
	  <script id="1" type="application/vnd.observable.javascript">"first output"</script>
	  <script id="2" type="application/vnd.observable.javascript">"second output"</script>
	</notebook>
`,
			attachments: {},
			_variables: {},
			options: {},
			_cell_widgets: ["anywidget:first", "anywidget:second"],
		});
		const firstModel = createModel({
			role: "cell",
			_cell_id: "first-source-cell",
			name: "first",
			_values: {},
			_value_names: [],
		});
		const secondModel = createModel({
			role: "cell",
			_cell_id: "second-source-cell",
			name: "second",
			_values: {},
			_value_names: [],
		});
		const childModels = new Map([
			["anywidget:first", firstModel],
			["anywidget:second", secondModel],
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

		await waitStep("parent first value", () =>
			variableValue(firstModel, "first") === "first output" ? "first output" : undefined,
		);
		await waitStep("parent second value", () =>
			variableValue(secondModel, "second") === "second output" ? "second output" : undefined,
		);

		const firstEl = document.createElement("div");
		widget.render({
			model: firstModel,
			el: firstEl,
			signal: controller.signal,
			host: createHost(new Map()),
		} as unknown as RenderProps<WidgetModel>);

		const secondEl = document.createElement("div");
		widget.render({
			model: secondModel,
			el: secondEl,
			signal: controller.signal,
			host: createHost(new Map()),
		} as unknown as RenderProps<WidgetModel>);

		await waitStep("first standalone output", () => standaloneInspectorText(firstEl, "first output"));
		await waitStep("second standalone output", () => standaloneInspectorText(secondEl, "second output"));
		controller.abort();
	});

	test("standalone source cells import parent values that shadow builtins", async () => {
		const model = createModel({
			role: "notebook",
			source: `
<notebook>
  <script id="1" type="module" pinned>
	const svg = {
	  node: () => {
	    const span = document.createElement("span");
	    span.textContent = "parent svg";
	    return span;
	  }
};
  </script>
  <script id="2" type="application/vnd.observable.javascript">svg.node()</script>
</notebook>
`,
			attachments: {},
			_variables: {},
			options: {},
			_cell_widgets: ["anywidget:source", "anywidget:display"],
		});
		const sourceModel = createModel({
			role: "cell",
			_cell_id: "module-source-cell",
			name: "source",
			_values: {},
			_value_names: [],
		});
		const displayModel = createModel({
			role: "cell",
			_cell_id: "module-display-cell",
			name: "display",
			_values: {},
			_value_names: [],
		});
		const childModels = new Map([
			["anywidget:source", sourceModel],
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
		await waitFor(() => composedText(parentEl, "parent svg"));

		const standaloneEl = document.createElement("div");
		widget.render({
			model: displayModel,
			el: standaloneEl,
			signal: controller.signal,
			host: createHost(new Map()),
		} as unknown as RenderProps<WidgetModel>);

		await waitFor(() => {
			const error = standaloneEl.querySelector(SELECTORS.error)?.textContent;
			if (error) throw new Error(error);
			return standaloneText(standaloneEl, "parent svg");
		});
		controller.abort();
	});

	test("standalone display cells keep parent and child DOM outputs separate", async () => {
		const model = createModel({
			role: "notebook",
			spec: {
				cells: [
					{
						id: 1,
						mode: "ojs",
						value: `
canvas = {
  const node = document.createElement("canvas");
  return node;
}`,
					},
				],
			},
			attachments: {},
			_variables: {},
			options: {},
			_cell_widgets: ["anywidget:canvas"],
		});
		const canvasModel = createModel({ role: "cell", name: "canvas", _values: {}, _value_names: [] });
		const childModels = new Map([["anywidget:canvas", canvasModel]]);
		const parentEl = document.createElement("div");
		const controller = new AbortController();

		widget.render({
			model,
			el: parentEl,
			signal: controller.signal,
			host: createHost(childModels, createCellExportsMap(childModels), renderChildrenThroughWidget(childModels)),
		} as unknown as RenderProps<WidgetModel>);
		const parentCanvas = await waitFor(() => onlyCanvas(parentEl));

		const standaloneEl = document.createElement("div");
		widget.render({
			model: canvasModel,
			el: standaloneEl,
			signal: controller.signal,
			host: createHost(new Map()),
		} as unknown as RenderProps<WidgetModel>);
		const standaloneCanvas = await waitFor(() => onlyCanvas(standaloneEl));

		expect(parentEl.contains(parentCanvas)).toBe(true);
		expect(standaloneCanvas).not.toBe(parentCanvas);
		expectCanvasOutputOnly(standaloneEl);
		controller.abort();
	});

	test("standalone source-backed display cells create DOM outputs in child root", async () => {
		const model = createModel({
			role: "notebook",
			source: `
<notebook>
  <script id="1" type="application/vnd.observable.javascript">
createCanvas = () => {
  const node = document.createElement("canvas");
  return node;
}
  </script>
  <script id="2" type="application/vnd.observable.javascript">canvas = createCanvas()</script>
</notebook>
`,
			attachments: {},
			_variables: {},
			options: {},
			_cell_widgets: ["anywidget:create-canvas", "anywidget:canvas"],
		});
		const createCanvasModel = createModel({ role: "cell", name: "createCanvas", _values: {}, _value_names: [] });
		const canvasModel = createModel({ role: "cell", name: "canvas", _values: {}, _value_names: [] });
		const childModels = new Map([
			["anywidget:create-canvas", createCanvasModel],
			["anywidget:canvas", canvasModel],
		]);
		const parentEl = document.createElement("div");
		const controller = new AbortController();

		widget.render({
			model,
			el: parentEl,
			signal: controller.signal,
			host: createHost(childModels, createCellExportsMap(childModels), renderChildrenThroughWidget(childModels)),
		} as unknown as RenderProps<WidgetModel>);
		const parentCanvas = await waitFor(() => onlyCanvas(parentEl));

		const standaloneEl = document.createElement("div");
		widget.render({
			model: canvasModel,
			el: standaloneEl,
			signal: controller.signal,
			host: createHost(new Map()),
		} as unknown as RenderProps<WidgetModel>);
		const standaloneCanvas = await waitFor(() => onlyCanvas(standaloneEl));

		expect(parentEl.contains(parentCanvas)).toBe(true);
		expect(standaloneCanvas).not.toBe(parentCanvas);
		expectCanvasOutputOnly(standaloneEl);
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
			return onlySelect(standaloneEl);
		});

		expect(select.value).toBe("two");
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
		await waitFor(() => standaloneText(titleEl, "Voronoi Spirals II"));

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
			return onlySelect(choiceEl);
		});

		expect(select.value).toBe("two");
		controller.abort();
	});

	test("standalone viewof cells resolve runtime-output dependencies that appear after the target", async () => {
		const cells: CellSpec[] = [
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
		];
		const notebook = toNotebook({ cells });
		const model = createModel({
			role: "notebook",
			spec: { cells },
			attachments: {},
			_variables: {},
			_graph: createNotebookGraph(notebook, ["choice", "items", "Select"]),
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
			return onlySelect(standaloneEl);
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

		await waitFor(() => {
			const error = standaloneEl.querySelector(SELECTORS.error)?.textContent;
			if (error) throw new Error(error);
			return inputWithValue(standaloneEl, "live:live");
		});
		xModel.set("_values", { x: "fresh" });
		await waitFor(() => inputWithValue(standaloneEl, "fresh:fresh"));
		controller.abort();
		xModel.set("_values", { x: "stale" });
		await flushStandaloneInvalidations();

		expect(onlyInput(standaloneEl).value).toBe("fresh:fresh");
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
			return inputWithValue(standaloneEl, "1:5");
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
  let selected = options.value ?? items[0];
  const paint = () => {
    picker.textContent = String(items.indexOf(selected) + 1);
  };
	  Object.defineProperty(picker, "value", {
	    get() { return selected; },
	    set(value) {
	      selected = value;
	      paint();
	    },
	  });
	  picker.addEventListener("click", () => {
	    selected = items[(items.indexOf(selected) + 1) % items.length];
	    paint();
	    picker.dispatchEvent(new Event("input", {bubbles: true}));
	    picker.dispatchEvent(new Event("change", {bubbles: true}));
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

		const parentPicker = await waitFor(() => onlyButton(parentEl));
		parentPicker.click();
		await waitFor(() => {
			const value = variableValue(presetsModel, "presets");
			return value && typeof value === "object" && (value as { pointDensity?: unknown }).pointDensity === 21
				? value
				: undefined;
		});
		await waitFor(() => rangeWithNumber(parentEl, 21));
		await waitFor(() => (variableValue(pointDensityModel, "pointDensity") === 21 ? 21 : undefined));
		pointDensityModel.set("_values", {});

		const standaloneEl = document.createElement("div");
		widget.render({
			model: pointDensityModel,
			el: standaloneEl,
			signal: controller.signal,
			host: createHost(new Map()),
		} as unknown as RenderProps<WidgetModel>);

		await waitFor(() => {
			const error = standaloneEl.querySelector(SELECTORS.error)?.textContent;
			if (error) throw new Error(error);
			return rangeWithNumber(standaloneEl, 21);
		});

		controller.abort();
	});

	test("standalone object-valued view updates keep composed selects selected", async () => {
		const model = createModel({
			role: "notebook",
			spec: {
				cells: [
					{
						id: 1,
						mode: "ojs",
						value: objectValuedSelectSource,
					},
					{ id: 2, mode: "ojs", value: "presetsArray = [{pointDensity: 7}, {pointDensity: 21}]" },
					{ id: 3, mode: "ojs", value: "viewof presets = Select(presetsArray, {value: presetsArray[0]})" },
					{ id: 4, mode: "ojs", value: "pointDensity = presets.pointDensity" },
				],
			},
			attachments: {},
			_variables: {},
			options: {},
			_cell_widgets: ["anywidget:select", "anywidget:presets-array", "anywidget:presets", "anywidget:point-density"],
		});
		const selectModel = createModel({ role: "cell", name: "select", _values: {}, _value_names: [] });
		const presetsArrayModel = createModel({ role: "cell", name: "presetsArray", _values: {}, _value_names: [] });
		const presetsModel = createModel({ role: "cell", name: "presets", _values: {}, _value_names: [] });
		const pointDensityModel = createModel({ role: "cell", name: "pointDensity", _values: {}, _value_names: [] });
		const childModels = new Map([
			["anywidget:select", selectModel],
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

		const parentSelect = await waitFor(() => onlySelect(parentEl));
		await waitFor(() => (variableValue(pointDensityModel, "pointDensity") === 7 ? 7 : undefined));

		const standaloneEl = document.createElement("div");
		widget.render({
			model: presetsModel,
			el: standaloneEl,
			signal: controller.signal,
			host: createHost(new Map()),
		} as unknown as RenderProps<WidgetModel>);

		const standaloneSelect = await waitFor(() => {
			const error = standaloneEl.querySelector(SELECTORS.error)?.textContent;
			if (error) throw new Error(error);
			return onlySelect(standaloneEl);
		});

		standaloneSelect.selectedIndex = 1;
		standaloneSelect.dispatchEvent(new Event("input", { bubbles: true }));
		standaloneSelect.dispatchEvent(new Event("change", { bubbles: true }));

		await waitFor(() => (variableValue(pointDensityModel, "pointDensity") === 21 ? 21 : undefined));
		expect(parentSelect.selectedIndex).toBe(1);
		expect(parentSelect.closest("form")?.value).toEqual({ pointDensity: 21 });
		expect(standaloneSelect.selectedIndex).toBe(1);
		controller.abort();
	});

	test("parent view changes update mounted standalone display cells", async () => {
		const controller = new AbortController();
		const { parentEl, firstStandaloneEl, secondStandaloneEl, parentSelect, standaloneSelect, presetsModel } =
			await mountPresetDisplayNotebook(controller);

		await waitStep("initial presets value", () => presetPointDensity(presetsModel, 7));
		await waitStep("initial parent display", () => displayForPointDensity(parentEl, 7));
		await waitStep("initial first standalone display", () => displayForPointDensity(firstStandaloneEl, 7));
		await waitStep("initial second standalone display", () => displayForPointDensity(secondStandaloneEl, 7));

		chooseOption(parentSelect, 1);

		await waitStep("parent change model value", () => presetPointDensity(presetsModel, 21));
		await waitStep("standalone select follows parent", () =>
			standaloneSelect.selectedIndex === 1 ? standaloneSelect : undefined,
		);
		await waitStep("parent display follows parent select", () => displayForPointDensity(parentEl, 21));
		await waitStep("first standalone display follows parent select", () =>
			displayForPointDensity(firstStandaloneEl, 21),
		);
		await waitStep("second standalone display follows parent select", () =>
			displayForPointDensity(secondStandaloneEl, 21),
		);
		controller.abort();
	});

	test("standalone view changes update parent and sibling display cells", async () => {
		const controller = new AbortController();
		const { parentEl, firstStandaloneEl, secondStandaloneEl, parentSelect, standaloneSelect, presetsModel } =
			await mountPresetDisplayNotebook(controller);

		await waitStep("initial presets value", () => presetPointDensity(presetsModel, 7));
		chooseOption(standaloneSelect, 1);

		await waitStep("standalone change model value", () => presetPointDensity(presetsModel, 21));
		await waitStep("parent select follows standalone", () =>
			parentSelect.selectedIndex === 1 ? parentSelect : undefined,
		);
		await waitStep("parent display follows standalone select", () => displayForPointDensity(parentEl, 21));
		await waitStep("first standalone display follows standalone select", () =>
			displayForPointDensity(firstStandaloneEl, 21),
		);
		await waitStep("second standalone display follows standalone select", () =>
			displayForPointDensity(secondStandaloneEl, 21),
		);
		controller.abort();
	});

	test("independent standalone cells preserve visible state across unrelated sibling changes", async () => {
		const controller = new AbortController();
		try {
			const model = createModel({
				role: "notebook",
				spec: {
					cells: [
						{
							id: 1,
							mode: "ojs",
							value: `
independent = {
  const input = document.createElement("input");
  input.value = "initial";
  return input;
}`,
						},
						{ id: 2, mode: "ojs", value: "gain = 1" },
					],
				},
				attachments: {},
				_variables: {},
				options: {},
				_cell_widgets: ["anywidget:independent", "anywidget:gain"],
			});
			const independentModel = createModel({ role: "cell", name: "independent", _values: {}, _value_names: [] });
			const gainModel = createModel({ role: "cell", name: "gain", _values: {}, _value_names: [] });
			const childModels = new Map([
				["anywidget:independent", independentModel],
				["anywidget:gain", gainModel],
			]);
			const childExports = createCellExportsMap(childModels);
			const childRenders = renderChildrenThroughWidget(childModels);
			const parentEl = document.createElement("div");
			const standaloneEl = document.createElement("div");

			widget.render({
				model,
				el: parentEl,
				signal: controller.signal,
				host: createHost(childModels, childExports, childRenders),
			} as unknown as RenderProps<WidgetModel>);
			await waitFor(() => (variableValue(gainModel, "gain") === 1 ? 1 : undefined));
			widget.render({
				model: independentModel,
				el: standaloneEl,
				signal: controller.signal,
				host: createHost(new Map()),
			} as unknown as RenderProps<WidgetModel>);

			const input = await waitFor(() => {
				return inputWithValue(standaloneEl, "initial");
			});
			input.value = "user edit";
			gainModel.set("_values", { gain: 2 });
			await waitFor(() => (variableValue(model, "gain") === 2 ? 2 : undefined));
			await flushStandaloneInvalidations();

			expect(onlyInput(standaloneEl).value).toBe("user edit");
		} finally {
			controller.abort();
		}
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

		await waitFor(() => {
			const error = standaloneEl.querySelector(SELECTORS.error)?.textContent;
			if (error) throw new Error(error);
			return standaloneInspectorText(standaloneEl, "ready");
		});
		controller.abort();
	});
});

async function mountPresetDisplayNotebook(controller: AbortController): Promise<{
	parentEl: HTMLDivElement;
	firstStandaloneEl: HTMLDivElement;
	secondStandaloneEl: HTMLDivElement;
	parentSelect: HTMLSelectElement;
	standaloneSelect: HTMLSelectElement;
	presetsModel: ReturnType<typeof createModel>;
}> {
	const model = createModel({
		role: "notebook",
		source: `
<notebook>
  <script id="1" type="application/vnd.observable.javascript">${objectValuedSelectSource}</script>
  <script id="2" type="application/vnd.observable.javascript">presetsArray = [{pointDensity: 7}, {pointDensity: 21}]</script>
  <script id="3" type="application/vnd.observable.javascript">viewof presets = Select(presetsArray, {value: presetsArray[0]})</script>
  <script id="4" type="application/vnd.observable.javascript">
display = {
  const node = document.createElement("output");
  node.textContent = String(presets.pointDensity);
  return node;
}
  </script>
</notebook>
`,
		attachments: {},
		_variables: {},
		options: {},
		_cell_widgets: ["anywidget:select", "anywidget:presets-array", "anywidget:presets", "anywidget:display"],
	});
	const selectModel = createModel({ role: "cell", name: "select", _values: {}, _value_names: [] });
	const presetsArrayModel = createModel({ role: "cell", name: "presetsArray", _values: {}, _value_names: [] });
	const presetsModel = createModel({ role: "cell", name: "presets", _values: {}, _value_names: [] });
	const displayModel = createModel({ role: "cell", name: "display", _values: {}, _value_names: [] });
	const childModels = new Map([
		["anywidget:select", selectModel],
		["anywidget:presets-array", presetsArrayModel],
		["anywidget:presets", presetsModel],
		["anywidget:display", displayModel],
	]);
	const childExports = createCellExportsMap(childModels);
	const childRenders = renderChildrenThroughWidget(childModels);
	const parentEl = document.createElement("div");
	const standalonePresetsEl = document.createElement("div");
	const firstStandaloneEl = document.createElement("div");
	const secondStandaloneEl = document.createElement("div");

	widget.render({
		model,
		el: parentEl,
		signal: controller.signal,
		host: createHost(childModels, childExports, childRenders),
	} as unknown as RenderProps<WidgetModel>);
	widget.render({
		model: presetsModel,
		el: standalonePresetsEl,
		signal: controller.signal,
		host: createHost(new Map()),
	} as unknown as RenderProps<WidgetModel>);
	for (const el of [firstStandaloneEl, secondStandaloneEl]) {
		widget.render({
			model: displayModel,
			el,
			signal: controller.signal,
			host: createHost(new Map()),
		} as unknown as RenderProps<WidgetModel>);
	}

	return {
		parentEl,
		firstStandaloneEl,
		secondStandaloneEl,
		parentSelect: await waitStep("parent select", () => onlySelect(parentEl)),
		standaloneSelect: await waitStep("standalone select", () => onlySelect(standalonePresetsEl)),
		presetsModel,
	};
}

async function waitStep<T>(label: string, read: () => T | undefined, timeoutMs?: number): Promise<T> {
	try {
		return await waitFor(read, timeoutMs);
	} catch (error) {
		throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function presetPointDensity(model: ReturnType<typeof createModel>, value: number): unknown | undefined {
	const preset = variableValue(model, "presets");
	return preset && typeof preset === "object" && (preset as { pointDensity?: unknown }).pointDensity === value
		? preset
		: undefined;
}

function standaloneText(el: HTMLElement, value: string): HTMLElement | undefined {
	const cells = Array.from(el.querySelectorAll<HTMLElement>(SELECTORS.standaloneCell));
	if (cells.length === 0) return undefined;
	if (cells.length > 1) throw new Error(`Expected one standalone cell, found ${cells.length}`);
	const [cell] = cells;
	const text = cell?.textContent?.trim() ?? "";
	if (text !== value) return undefined;
	return cell;
}

function standaloneInspectorText(el: HTMLElement, value: string): HTMLElement | undefined {
	const cells = Array.from(el.querySelectorAll<HTMLElement>(SELECTORS.standaloneCell));
	if (cells.length === 0) return undefined;
	if (cells.length > 1) throw new Error(`Expected one standalone cell, found ${cells.length}`);
	const [cell] = cells;
	const text = cell?.textContent?.trim() ?? "";
	if (text !== value && text !== `"${value}"`) return undefined;
	return cell;
}

function composedText(el: HTMLElement, value: string): HTMLElement | undefined {
	const cells = Array.from(el.querySelectorAll<HTMLElement>(SELECTORS.composedCell));
	if (cells.length === 0) return undefined;
	const matches = cells.filter((cell) => (cell.textContent?.trim() ?? "") === value);
	if (matches.length === 0) return undefined;
	if (matches.length > 1) throw new Error(`Expected one composed cell with ${value}, found ${matches.length}`);
	return matches[0]!;
}

function composedInspectorText(el: HTMLElement, value: string): HTMLElement | undefined {
	const cells = Array.from(el.querySelectorAll<HTMLElement>(SELECTORS.composedCell));
	if (cells.length === 0) return undefined;
	const matches = cells.filter((cell) => {
		const text = cell.textContent?.trim() ?? "";
		return text === value || text === `"${value}"`;
	});
	if (matches.length === 0) return undefined;
	if (matches.length > 1) throw new Error(`Expected one composed cell with ${value}, found ${matches.length}`);
	return matches[0]!;
}

function onlyInput(el: HTMLElement): HTMLInputElement {
	const inputs = Array.from(el.querySelectorAll<HTMLInputElement>("input"));
	if (inputs.length !== 1) throw new Error(`Expected one input, found ${inputs.length}`);
	return inputs[0]!;
}

function inputWithValue(el: HTMLElement, value: string): HTMLInputElement | undefined {
	const inputs = Array.from(el.querySelectorAll<HTMLInputElement>("input"));
	if (inputs.length === 0) return undefined;
	if (inputs.length > 1) throw new Error(`Expected one input, found ${inputs.length}`);
	const [input] = inputs;
	return input?.value === value ? input : undefined;
}

function rangeWithNumber(el: HTMLElement, value: number): HTMLInputElement | undefined {
	const inputs = Array.from(el.querySelectorAll<HTMLInputElement>("input[type='range']"));
	if (inputs.length === 0) return undefined;
	if (inputs.length > 1) throw new Error(`Expected one range input, found ${inputs.length}`);
	const [input] = inputs;
	return input?.valueAsNumber === value ? input : undefined;
}

function onlySelect(el: HTMLElement): HTMLSelectElement | undefined {
	const selects = Array.from(el.querySelectorAll<HTMLSelectElement>("select"));
	if (selects.length === 0) return undefined;
	if (selects.length > 1) throw new Error(`Expected one select, found ${selects.length}`);
	return selects[0]!;
}

function onlyCanvas(el: HTMLElement): HTMLCanvasElement | undefined {
	const canvases = Array.from(el.querySelectorAll<HTMLCanvasElement>("canvas"));
	if (canvases.length === 0) return undefined;
	if (canvases.length > 1) throw new Error(`Expected one canvas, found ${canvases.length}`);
	return canvases[0]!;
}

function onlyButton(el: HTMLElement): HTMLButtonElement | undefined {
	const buttons = Array.from(el.querySelectorAll<HTMLButtonElement>("button"));
	if (buttons.length === 0) return undefined;
	if (buttons.length > 1) throw new Error(`Expected one button, found ${buttons.length}`);
	return buttons[0]!;
}

function expectCanvasOutputOnly(el: HTMLElement): void {
	const outputs = Array.from(el.querySelectorAll(SELECTORS.standaloneCell));
	expect(outputs).toHaveLength(1);
	const [output] = outputs;
	const canvases = Array.from(output?.querySelectorAll("canvas") ?? []);
	expect(canvases).toHaveLength(1);
	expect(output?.querySelector(SELECTORS.error)).toBeNull();
}

function displayForPointDensity(el: HTMLElement, value: number): HTMLOutputElement | undefined {
	const error = el.querySelector(SELECTORS.error)?.textContent;
	if (error) throw new Error(error);
	const outputs = Array.from(el.querySelectorAll<HTMLOutputElement>("output"));
	if (outputs.length === 0) return undefined;
	if (outputs.length > 1) throw new Error(`Expected one output, found ${outputs.length}`);
	const [output] = outputs;
	return output?.textContent?.trim() === String(value) ? output : undefined;
}

function projectErrorText(el: HTMLElement): string | undefined {
	const errors = Array.from(el.querySelectorAll<HTMLElement>(SELECTORS.error));
	if (errors.length === 0) return undefined;
	if (errors.length > 1) throw new Error(`Expected one error output, found ${errors.length}`);
	const text = errors[0]?.textContent?.trim() ?? "";
	return text || undefined;
}

function chooseOption(select: HTMLSelectElement, index: number): void {
	select.selectedIndex = index;
	select.dispatchEvent(new Event("input", { bubbles: true }));
	select.dispatchEvent(new Event("change", { bubbles: true }));
	const view = select.closest("form");
	view?.dispatchEvent(new Event("input", { bubbles: true }));
	view?.dispatchEvent(new Event("change", { bubbles: true }));
}

async function flushStandaloneInvalidations(): Promise<void> {
	await new Promise<void>((resolve) => queueMicrotask(resolve));
}
