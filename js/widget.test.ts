// @vitest-environment jsdom

import type { RenderProps } from "@anywidget/types";
import { describe, expect, test } from "vitest";
import type { CellExports, NotebookGraph, WidgetModel } from "./types";
import widget from "./widget";

type Model = RenderProps<WidgetModel>["model"];

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
			_data: {},
			options: {},
			_cell_widgets: ["anywidget:cell-1", "anywidget:cell-2"],
		});
		const childModels = new Map([
			["anywidget:cell-1", createModel({ role: "cell", name: "answer", variables: {}, variable_names: [] })],
			["anywidget:cell-2", createModel({ role: "cell", name: "readout", variables: {}, variable_names: [] })],
		]);
		const controller = new AbortController();

		widget.render({
			model,
			el: document.createElement("div"),
			signal: controller.signal,
			host: {
				getModel: async (ref: string) => childModels.get(ref),
				getWidget: async () => ({ exports: noopCellExports }),
			},
		} as unknown as RenderProps<WidgetModel>);

		const graph = await waitFor(() => model.get("_graph") as NotebookGraph | undefined);

		expect(graph.cells.map((cell) => cell.name)).toEqual(["answer", "readout"]);
		expect(graph.cells.map((cell) => cell.defines)).toEqual([["answer"], []]);
		expect(graph.cells[1]?.references).toEqual(["answer"]);
		expect(graph.edges).toEqual([{ from: 1, to: 2, name: "answer" }]);
		const childModel = childModels.get("anywidget:cell-1") as unknown as { get(name: string): unknown };
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
			_data: {},
			options: {},
			_cell_widgets: ["anywidget:gain", "anywidget:readout"],
		});
		const childModels = new Map([
			["anywidget:gain", createModel({ role: "cell", name: "gain", variables: {}, variable_names: [] })],
			["anywidget:readout", createModel({ role: "cell", name: "readout", variables: {}, variable_names: [] })],
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
		gainModel?.set("variable_names", ["gain"]);
		gainModel?.set("variables", { gain: 5 });
		expect(await waitFor(() => variableValue(model, "gain"))).toBe(5);

		gainModel?.set("variables", { gain: 7.5 });
		const changedGain = await waitFor(() => (variableValue(model, "gain") === 7.5 ? 7.5 : undefined));

		childModels.get("anywidget:readout")?.set("variable_names", ["readout"]);
		childModels.get("anywidget:readout")?.set("variables", { readout: 15 });
		await waitFor(() => variableValue(model, "readout"));

		expect(changedGain).toBe(7.5);
		expect(model.get("variables")).toEqual({ gain: 7.5, readout: 15 });
		expect(model.get("variable_names")).toEqual(["gain", "readout"]);
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
			_data: {},
			options: {},
			_cell_widgets: ["anywidget:source-1", "anywidget:source-2"],
		});
		const childModels = new Map([
			["anywidget:source-1", createModel({ role: "cell", name: "answer", variables: {}, variable_names: [] })],
			["anywidget:source-2", createModel({ role: "cell", name: "double", variables: {}, variable_names: [] })],
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
		expect(graph.edges).toEqual([{ from: 1, to: 2, name: "answer" }]);
		controller.abort();
	});
});

const noopCellExports: CellExports = {
	bindRuntime() {},
	unbindRuntime() {},
	renderComposed() {},
};

function createModel(initial: Partial<WidgetModel>): Model {
	const state = new Map<string, unknown>(Object.entries(initial));
	const listeners = new Map<string, Set<() => void>>();
	return {
		get(name: string) {
			return state.get(name);
		},
		set(name: string, value: unknown) {
			state.set(name, value);
			for (const listener of listeners.get(`change:${name}`) ?? []) listener();
		},
		save_changes() {},
		on(name: string, callback: () => void) {
			const callbacks = listeners.get(name) ?? new Set();
			callbacks.add(callback);
			listeners.set(name, callbacks);
		},
		off(name: string, callback: () => void) {
			listeners.get(name)?.delete(callback);
		},
	} as unknown as Model;
}

function createHost(
	childModels: Map<string, Model>,
	childExports: Map<string, CellExports> = new Map(),
): RenderProps<WidgetModel>["host"] {
	return {
		getModel: async (ref: string) => childModels.get(ref),
		getWidget: async (ref: string) => ({ exports: childExports.get(ref) ?? noopCellExports }),
	} as unknown as RenderProps<WidgetModel>["host"];
}

function variableValue(model: Model, name: string): unknown | undefined {
	const variables = model.get("variables");
	if (variables === null || typeof variables !== "object" || Array.isArray(variables)) return undefined;
	return (variables as Record<string, unknown>)[name];
}

async function waitFor<T>(read: () => T | undefined): Promise<T> {
	const deadline = performance.now() + 1000;
	return new Promise<T>((resolve, reject) => {
		const check = () => {
			const value = read();
			if (value !== undefined) {
				resolve(value);
			} else if (performance.now() >= deadline) {
				reject(new Error("Timed out waiting for value"));
			} else {
				window.setTimeout(check, 10);
			}
		};
		check();
	});
}
