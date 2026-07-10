import type { Notebook } from "@observablehq/notebook-kit";
import {
	createNotebookGraph,
	createNotebookGraphFromAnalysis,
	sameWireValue,
	type NotebookAnalysis,
	type NotebookGraph,
} from "@pyobservablejs/runtime";
import { readModelVariables, type AnyWidgetModel } from "./model";

export function markRendered(model: AnyWidgetModel): void {
	if (model.get("_has_rendered") === true) return;
	model.set("_has_rendered", true);
	model.save_changes();
}

export function markUnrendered(model: AnyWidgetModel): void {
	if (model.get("_has_rendered") === false) return;
	model.set("_has_rendered", false);
	model.save_changes();
}

export function resetRenderReadback(model: AnyWidgetModel): void {
	let changed = false;
	if (model.get("_has_rendered") !== false) {
		model.set("_has_rendered", false);
		changed = true;
	}
	if (!sameWireValue(model.get("_values"), {})) {
		model.set("_values", {});
		changed = true;
	}
	if (Array.isArray(model.get("_value_names")) && !sameWireValue(model.get("_value_names"), [])) {
		model.set("_value_names", []);
		changed = true;
	}
	if (changed) model.save_changes();
}

export function resetGraphSnapshot(model: AnyWidgetModel): void {
	if (sameWireValue(model.get("_graph"), {})) return;
	model.set("_graph", {} as NotebookGraph);
	model.save_changes();
}

export function syncNotebookGraph(
	model: AnyWidgetModel,
	notebook: Notebook,
	keys: readonly string[] = [],
	analysis?: NotebookAnalysis,
): void {
	const graph = analysis ? createNotebookGraphFromAnalysis(analysis, keys) : createNotebookGraph(notebook, keys);
	if (!sameWireValue(model.get("_graph"), graph)) {
		model.set("_graph", graph);
		model.save_changes();
	}
}

export function syncNotebookValues(model: AnyWidgetModel, cellModels: AnyWidgetModel[]): void {
	const counts = new Map<string, number>();
	const values: Record<string, unknown> = {};
	for (const cellModel of cellModels) {
		for (const [name, value] of Object.entries(readModelVariables(cellModel))) {
			counts.set(name, (counts.get(name) ?? 0) + 1);
			values[name] = value;
		}
	}
	const variables = Object.fromEntries(Object.entries(values).filter(([name]) => counts.get(name) === 1));
	if (!sameWireValue(model.get("_values"), variables)) {
		model.set("_values", variables);
		model.save_changes();
	}
}
