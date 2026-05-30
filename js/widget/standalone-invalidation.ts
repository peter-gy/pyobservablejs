import type { RenderProps } from "@anywidget/types";
import type { WidgetModel } from "../model/types";
import type { CellGraph, NotebookGraph } from "../observable/types";
import type { CellRenderContext } from "./types";

/**
 * Re-render a standalone cell when one of its dependency models publishes a new value.
 */
export function bindStandaloneDependencyInvalidation(
	model: RenderProps<WidgetModel>["model"],
	context: CellRenderContext,
	signal: AbortSignal,
	rerender: () => void,
): void {
	const dependencies = standaloneDependencyModels(model, context);
	if (dependencies.length === 0) return;
	let queued = false;
	const schedule = () => {
		if (queued || signal.aborted) return;
		queued = true;
		queueMicrotask(() => {
			queued = false;
			if (!signal.aborted) rerender();
		});
	};
	for (const dependency of dependencies) {
		dependency.on("change:_value_names", schedule);
		dependency.on("change:_values", schedule);
	}
	signal.addEventListener(
		"abort",
		() => {
			for (const dependency of dependencies) {
				dependency.off("change:_value_names", schedule);
				dependency.off("change:_values", schedule);
			}
		},
		{ once: true },
	);
}

function standaloneDependencyModels(
	model: RenderProps<WidgetModel>["model"],
	context: CellRenderContext,
): Array<RenderProps<WidgetModel>["model"]> {
	const graph = readNotebookGraph(context.notebookModel);
	const candidates = graph
		? transitiveDependencyIndexes(graph, context.cellIndex).map((index) => context.cellModels[index])
		: context.cellModels;
	return Array.from(
		new Set(
			candidates.filter(
				(candidate): candidate is RenderProps<WidgetModel>["model"] => candidate !== undefined && candidate !== model,
			),
		),
	);
}

function transitiveDependencyIndexes(graph: NotebookGraph, cellIndex: number): number[] {
	const target = graph.cells.find((cell) => cell.index === cellIndex);
	if (!target) return [];
	const cellsById = new Map(graph.cells.map((cell) => [cell.id, cell]));
	const indexes = new Set<number>();
	const visit = (cell: CellGraph) => {
		for (const edge of graph.edges) {
			if (edge.to !== cell.id) continue;
			const source = cellsById.get(edge.from);
			if (!source || indexes.has(source.index)) continue;
			indexes.add(source.index);
			visit(source);
		}
	};
	visit(target);
	return Array.from(indexes);
}

function readNotebookGraph(model: RenderProps<WidgetModel>["model"]): NotebookGraph | null {
	const graph = model.get("_graph");
	if (!graph || typeof graph !== "object") return null;
	const candidate = graph as Partial<NotebookGraph>;
	return Array.isArray(candidate.cells) && Array.isArray(candidate.edges) ? (graph as NotebookGraph) : null;
}
