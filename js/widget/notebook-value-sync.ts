import type { RenderProps } from "@anywidget/types";
import type { Notebook } from "@observablehq/notebook-kit";
import { readModelVariableNames, readModelVariables } from "../model/values";
import type { WidgetModel } from "../model/types";
import { createNotebookGraph } from "../observable/graph";
import { sameWireValue } from "../runtime/wire";

/**
 * Publish the notebook dependency graph through the parent model.
 */
export function syncNotebookGraph(
	model: RenderProps<WidgetModel>["model"],
	notebook: Notebook,
	cellModels: Array<RenderProps<WidgetModel>["model"] | undefined> = [],
): void {
	const names = cellModels.map((cellModel) => cellModel?.get("name") ?? "");
	const graph = createNotebookGraph(notebook, names);
	if (!sameWireValue(model.get("_graph"), graph)) {
		model.set("_graph", graph);
		model.save_changes();
	}
}

/**
 * Keep parent notebook values aligned with child cell model outputs.
 */
export function bindNotebookValueSync(
	model: RenderProps<WidgetModel>["model"],
	cellModels: Array<RenderProps<WidgetModel>["model"]>,
	signal: AbortSignal,
): void {
	const sync = () => syncNotebookValues(model, cellModels);
	sync();
	for (const cellModel of cellModels) {
		cellModel.on("change:_value_names", sync);
		cellModel.on("change:_values", sync);
	}
	signal.addEventListener(
		"abort",
		() => {
			for (const cellModel of cellModels) {
				cellModel.off("change:_value_names", sync);
				cellModel.off("change:_values", sync);
			}
		},
		{ once: true },
	);
}

/**
 * Aggregate child values into the notebook-level public value map.
 *
 * Duplicate variable names stay listed in `_value_names`, but are omitted from
 * `_values` because Python cannot choose one owner safely.
 */
export function syncNotebookValues(
	model: RenderProps<WidgetModel>["model"],
	cellModels: Array<RenderProps<WidgetModel>["model"]>,
): void {
	const names: string[] = [];
	const counts = new Map<string, number>();
	const values: Record<string, unknown> = {};
	for (const cellModel of cellModels) {
		for (const name of readModelVariableNames(cellModel)) {
			if (!names.includes(name)) names.push(name);
		}
		for (const [name, value] of Object.entries(readModelVariables(cellModel))) {
			if (!names.includes(name)) names.push(name);
			counts.set(name, (counts.get(name) ?? 0) + 1);
			values[name] = value;
		}
	}
	const variables = Object.fromEntries(Object.entries(values).filter(([name]) => counts.get(name) === 1));
	let changed = false;
	if (!sameWireValue(model.get("_value_names"), names)) {
		model.set("_value_names", names);
		changed = true;
	}
	if (!sameWireValue(model.get("_values"), variables)) {
		model.set("_values", variables);
		changed = true;
	}
	if (changed) model.save_changes();
}
