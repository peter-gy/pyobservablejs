import type { RenderProps } from "@anywidget/types";
import type { Notebook } from "@observablehq/notebook-kit";
import type { NotebookRuntime } from "@observablehq/notebook-kit/runtime";
import type { NotebookAnalysis } from "../notebook/graph";
import type { NotebookOptions, RuntimeVariablesSync } from "../runtime";
import { renderCell, renderCellError } from "./cells";
import { appendCellWrapper } from "./dom";
import type { WidgetModel } from "./model";
import { createCellModelSync, syncNotebookGraph, syncNotebookValues } from "./sync";

const MODEL_LOOKUP_TIMEOUT_MS = 1_000;
const MODEL_LOOKUP_RETRY_MS = 25;

export type CompositionHost = {
	getModel(ref: string, signal?: AbortSignal): Promise<RenderProps<WidgetModel>["model"] | undefined>;
};

/**
 * Resolve child widget models through anywidget's native host surface, with
 * `widget_manager` as the same model lookup path used by anywidget's host.
 */
export function createCompositionHost(
	host: RenderProps<WidgetModel>["host"] | undefined,
	model: RenderProps<WidgetModel>["model"],
): CompositionHost {
	return {
		getModel(ref, signal) {
			parseWidgetRef(ref);
			if (host?.getModel) {
				return getModelWithRetry(() => host.getModel<WidgetModel>(ref), signal);
			}
			return getModelFromWidgetManager(model, ref, signal);
		},
	};
}

/**
 * Resolve a child model through native anywidget composition.
 */
export async function resolveCellModel(
	host: CompositionHost,
	ref: string,
	signal: AbortSignal,
): Promise<RenderProps<WidgetModel>["model"]> {
	parseWidgetRef(ref);
	if (signal.aborted) throw new Error(`Unable to resolve cell widget ${ref}`);
	const childModel = await host.getModel(ref, signal);
	if (signal.aborted) throw new Error(`Unable to resolve cell widget ${ref}`);
	if (!childModel) throw new Error(`Unknown widget model ${ref}`);
	return childModel;
}

export function parseWidgetRef(ref: string): string {
	if (typeof ref !== "string" || !ref.startsWith("anywidget:")) {
		throw new Error(`Malformed widget reference: ${String(ref)}`);
	}
	const modelId = ref.slice("anywidget:".length);
	if (!modelId) throw new Error(`Malformed widget reference: ${String(ref)}`);
	return modelId;
}

async function getModelFromWidgetManager(
	model: RenderProps<WidgetModel>["model"],
	ref: string,
	signal: AbortSignal | undefined,
): Promise<RenderProps<WidgetModel>["model"] | undefined> {
	const modelId = parseWidgetRef(ref);
	const manager = model.widget_manager;
	if (!manager || typeof manager.get_model !== "function") {
		throw new Error("This anywidget host cannot resolve child widget models");
	}
	return getModelWithRetry(() => manager.get_model(modelId), signal);
}

async function getModelWithRetry(
	getModel: () =>
		| Promise<RenderProps<WidgetModel>["model"] | undefined>
		| RenderProps<WidgetModel>["model"]
		| undefined,
	signal: AbortSignal | undefined,
): Promise<RenderProps<WidgetModel>["model"] | undefined> {
	const deadline = Date.now() + MODEL_LOOKUP_TIMEOUT_MS;
	let lastError: unknown;
	const lookup = async (): Promise<RenderProps<WidgetModel>["model"] | undefined> => {
		if (signal?.aborted) return undefined;
		try {
			const childModel = await getModel();
			if (childModel) return childModel;
		} catch (error) {
			// Child models can be registered just after the parent render starts.
			lastError = error;
		}
		if (Date.now() >= deadline) {
			if (lastError !== undefined) throw lastError;
			return undefined;
		}
		await waitForModelRetry(signal);
		return lookup();
	};
	return lookup();
}

function waitForModelRetry(signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		let timeout: ReturnType<typeof setTimeout>;
		const done = () => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", done);
			resolve();
		};
		timeout = setTimeout(done, MODEL_LOOKUP_RETRY_MS);
		signal?.addEventListener("abort", done, { once: true });
	});
}

/**
 * Resolve child widgets, bind each one to the parent runtime, and render them
 * in notebook order.
 */
export async function renderComposedCells(
	model: RenderProps<WidgetModel>["model"],
	root: HTMLElement,
	notebook: Notebook,
	cellRefs: string[],
	analysis: NotebookAnalysis,
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
		syncNotebookGraph(model, notebook, cellModels, analysis);
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
			analysis: analysis.cells[resolution.index],
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
