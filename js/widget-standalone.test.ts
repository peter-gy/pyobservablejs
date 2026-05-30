// @vitest-environment jsdom

import type { RenderProps } from "@anywidget/types";
import { toNotebook, type CellSpec } from "@observablehq/notebook-kit";
import { describe, expect, test } from "vitest";
import { createNotebookGraph } from "./observable/graph";
import { SELECTORS } from "./widget/dom-contract";
import type { CellRenderContext, WidgetModel } from "./widget/types";
import widget from "./widget";
import {
	type ChildRender,
	createCellExports,
	createCellExportsMap,
	createHost,
	createModel,
	renderChildrenThroughWidget,
	variableValue,
	waitFor,
} from "./widget-test-utils";
import {
	composedInspectorText,
	composedText,
	expectCanvasOutputOnly,
	flushStandaloneInvalidations,
	inputWithValue,
	onlyButton,
	onlyCanvas,
	onlyInput,
	onlySelect,
	rangeWithNumber,
	standaloneInspectorText,
	standaloneText,
	waitStep,
} from "./widget-dom-test-utils";

describe("widget standalone cells", () => {
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
});
