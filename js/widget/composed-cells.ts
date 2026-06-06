import type { RenderProps } from "@anywidget/types";
import type { Notebook } from "@observablehq/notebook-kit";
import type { NotebookRuntime } from "@observablehq/notebook-kit/runtime";
import type { WidgetModel } from "../model/types";
import type { NotebookOptions, RuntimeVariablesSync } from "../runtime/types";
import { createCellModelSync } from "./cell-value-sync";
import { renderCell, renderCellError } from "./cell-renderer";
import { resolveCellModel } from "./composition-host";
import { appendCellWrapper } from "./dom";
import { syncNotebookGraph, syncNotebookValues } from "./notebook-value-sync";
import type { CompositionHost } from "./types";

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
	const cellModels: Array<RenderProps<WidgetModel>["model"] | undefined> = Array.from(
		{ length: cells.length },
		() => undefined,
	);
	const syncValues = () => syncNotebookValues(model, resolvedCellModels(cellModels));
	syncValues();

	const resolutions = cellRefs.map((ref, index) =>
		resolveCellModel(host, ref, signal).then(
			(childModel) => ({ childModel, index }),
			(error: unknown) => ({ error, index }),
		),
	);
	for (const resolution of resolutions) void resolution.then((result) => renderResolvedCell(result));
	await Promise.all(resolutions);
	if (!signal.aborted) {
		syncNotebookGraph(model, notebook, cellModels);
		variablesSync.applyInitialViews();
	}

	function renderResolvedCell(
		resolution: { childModel: RenderProps<WidgetModel>["model"]; index: number } | { error: unknown; index: number },
	): void {
		if (signal.aborted) return;
		const wrapper = wrappers[resolution.index];
		if (!wrapper) return;
		if ("error" in resolution) {
			renderCellError(wrapper, resolution.error);
			return;
		}
		const cell = cells[resolution.index];
		if (!cell) return;
		const childModel = resolution.childModel;
		cellModels[resolution.index] = childModel;
		bindResolvedCellModel(childModel);
		const sync = createCellModelSync(childModel, signal, variablesSync);
		renderCell({
			wrapper,
			runtime,
			cell,
			showSource: options.showSource,
			sync,
			signal,
			cellName: sync.model.get("name"),
			pythonVariableNames: new Set(Object.keys(options.variables)),
		});
	}

	function bindResolvedCellModel(cellModel: RenderProps<WidgetModel>["model"]): void {
		syncValues();
		cellModel.on("change:_value_names", syncValues);
		cellModel.on("change:_values", syncValues);
		signal.addEventListener(
			"abort",
			() => {
				cellModel.off("change:_value_names", syncValues);
				cellModel.off("change:_values", syncValues);
			},
			{ once: true },
		);
	}
}

function resolvedCellModels(
	cellModels: Array<RenderProps<WidgetModel>["model"] | undefined>,
): Array<RenderProps<WidgetModel>["model"]> {
	return cellModels.filter((cellModel): cellModel is RenderProps<WidgetModel>["model"] => cellModel !== undefined);
}
