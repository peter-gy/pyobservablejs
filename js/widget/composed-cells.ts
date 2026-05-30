import type { RenderProps } from "@anywidget/types";
import type { Notebook } from "@observablehq/notebook-kit";
import type { NotebookRuntime } from "@observablehq/notebook-kit/runtime";
import type { WidgetModel } from "../model/types";
import type { NotebookOptions, RuntimeVariablesSync } from "../runtime/types";
import { createCellModelSync } from "./cell-value-sync";
import { renderCellError } from "./cell-renderer";
import { resolveCellWidget } from "./composition-host";
import { appendCellWrapper } from "./dom";
import { bindNotebookValueSync, syncNotebookGraph } from "./notebook-value-sync";
import type { CellRenderContext, CompositionHost } from "./types";

/**
 * Resolve child widgets, bind each one to the parent runtime, and render them
 * in notebook order.
 */
export async function renderComposedCells(
	model: RenderProps<WidgetModel>["model"],
	root: HTMLElement,
	notebook: Notebook,
	cellRefs: string[],
	runtime: NotebookRuntime,
	options: NotebookOptions,
	variablesSync: RuntimeVariablesSync,
	signal: AbortSignal,
	host: CompositionHost,
): Promise<void> {
	const cells = notebook.cells;
	const wrappers = cells.map((_, index) => {
		return appendCellWrapper(root, { composedCellRef: cellRefs[index] ?? "" });
	});
	const resolvedCells = await Promise.allSettled(cellRefs.map((ref) => resolveCellWidget(host, ref, signal)));
	if (signal.aborted) return;

	const cellModels: Array<RenderProps<WidgetModel>["model"] | undefined> = resolvedCells.map((result) =>
		result.status === "fulfilled" ? result.value[1] : undefined,
	);
	const graphCellModels = cellModels.filter(
		(cellModel): cellModel is RenderProps<WidgetModel>["model"] => cellModel !== undefined,
	);
	if (graphCellModels.length === cells.length) {
		syncNotebookGraph(model, notebook, graphCellModels);
		bindNotebookValueSync(model, graphCellModels, signal);
	}
	let renderTask = Promise.resolve();
	for (let index = 0; index < cells.length; index++) {
		if (signal.aborted) return;
		const cell = cells[index];
		const wrapper = wrappers[index];
		const resolved = resolvedCells[index];
		if (!wrapper || !resolved) continue;
		if (resolved.status === "rejected") {
			renderCellError(wrapper, resolved.reason);
			continue;
		}
		const [child, childModel] = resolved.value;
		const sync = createCellModelSync(childModel, signal, variablesSync);
		const context: CellRenderContext = {
			notebookModel: model,
			runtime,
			showSource: options.showSource,
			cell,
			cellIndex: index,
			notebook,
			options,
			cellModels,
			sync,
		};
		child.exports.bindRuntime(context);
		signal.addEventListener("abort", () => child.exports.unbindRuntime(context), { once: true });
		child.exports.prepareComposedRender(wrapper, context);
		renderTask = renderTask.then(() => child.render({ el: wrapper, signal }));
	}
	await renderTask;
	if (!signal.aborted) variablesSync.applyInitialViews();
}
