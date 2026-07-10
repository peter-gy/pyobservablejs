import type { Host, RenderProps } from "@anywidget/types";
import type { Cell, Notebook } from "@observablehq/notebook-kit";
import type { NotebookRuntime } from "@observablehq/notebook-kit/runtime";
import {
	notebookDefinedNamesFromAnalysis,
	notebookDependencyIndexes,
	type NotebookAnalysis,
	type NotebookOptions,
	type RuntimeVariablesSync,
} from "@pyobservablejs/runtime";
import { renderCellTarget, renderCellTargets, type CellRenderContext, type CellRenderTarget } from "./cell-renderer";
import { readNotebookCompositionState, type NotebookCompositionState } from "./composition-state";
import { appendCellWrapper, createTopLevelError } from "./dom";
import type { WidgetModel } from "./model";
import { markRendered, markUnrendered, resetRenderReadback, syncNotebookGraph, syncNotebookValues } from "./readback";
import { createCellModelSync } from "./variable-sync";

type RenderComposedCellsOptions = {
	model: RenderProps<WidgetModel>["model"];
	root: HTMLElement;
	notebook: Notebook;
	composition: NotebookCompositionState;
	analysis: NotebookAnalysis;
	runtime: NotebookRuntime;
	options: NotebookOptions;
	variablesSync: RuntimeVariablesSync;
	signal: AbortSignal;
	host: CompositionHost;
	onCellResolved(model: RenderProps<WidgetModel>["model"]): void;
};

type RenderStandaloneCellProjectionOptions = {
	parentModel: RenderProps<WidgetModel>["model"];
	cellModel: RenderProps<WidgetModel>["model"];
	root: HTMLElement;
	notebook: Notebook;
	cellIndex: number;
	analysis: NotebookAnalysis;
	runtime: NotebookRuntime;
	options: NotebookOptions;
	variablesSync: RuntimeVariablesSync;
	signal: AbortSignal;
};

type AnyWidgetModel = RenderProps<WidgetModel>["model"];

export type CompositionHost = {
	getModel(ref: string): Promise<AnyWidgetModel>;
};

/**
 * Use the anywidget render host when available. Renderers that omit it can
 * resolve referenced models through the model manager used by anywidget's
 * host implementation.
 */
export function createCompositionHost(host: Host | undefined, model: AnyWidgetModel): CompositionHost {
	if (host?.getModel) {
		return {
			getModel(ref) {
				return host.getModel<WidgetModel>(ref);
			},
		};
	}
	return {
		async getModel(ref) {
			const manager = model.widget_manager;
			if (!manager || typeof manager.get_model !== "function") {
				throw new Error("This anywidget host cannot resolve child widget models");
			}
			return await manager.get_model<WidgetModel>(widgetModelId(ref));
		},
	};
}

/**
 * Resolve a child model through the anywidget host.
 */
export async function resolveCellModel(
	host: CompositionHost,
	ref: string,
	signal: AbortSignal,
): Promise<RenderProps<WidgetModel>["model"]> {
	const message = `Unable to resolve cell widget ${ref}`;
	if (signal.aborted) throw new Error(message);
	const childModel = await resolveHostModel(
		Promise.resolve().then(() => host.getModel(ref)),
		signal,
		message,
	);
	if (signal.aborted) throw new Error(message);
	return childModel;
}

export async function resolveNotebookModel(
	host: CompositionHost,
	ref: string,
	signal: AbortSignal,
): Promise<RenderProps<WidgetModel>["model"]> {
	const message = `Unable to resolve parent Notebook widget ${ref}`;
	if (signal.aborted) throw new Error(message);
	const parentModel = await resolveHostModel(
		Promise.resolve().then(() => host.getModel(ref)),
		signal,
		message,
	);
	if (signal.aborted) throw new Error(message);
	if (parentModel.get("role") !== "notebook") throw new Error(`Parent widget ${ref} is not a Notebook`);
	return parentModel;
}

function resolveHostModel<T>(lookup: Promise<T>, signal: AbortSignal, abortMessage: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		const onAbort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(new Error(abortMessage));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		lookup.then(
			(value) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			},
		);
	});
}

function widgetModelId(ref: string): string {
	const prefix = "anywidget:";
	if (!ref.startsWith(prefix) || ref.length === prefix.length) {
		throw new Error(`Malformed widget reference: ${ref}`);
	}
	return ref.slice(prefix.length);
}

/**
 * Resolve child widgets, bind each one to the parent runtime, and render them
 * in notebook order.
 */
export async function renderComposedCells({
	model,
	root,
	notebook,
	composition,
	analysis,
	runtime,
	options,
	variablesSync,
	signal,
	host,
	onCellResolved,
}: RenderComposedCellsOptions): Promise<Array<RenderProps<WidgetModel>["model"]>> {
	const cells = notebook.cells;
	const wrappers = cells.map((_, index) => {
		return appendCellWrapper(root, {
			composedCellRef: composition.cellRefs[index] ?? "",
		});
	});
	const cellModels: Array<RenderProps<WidgetModel>["model"] | undefined> = Array.from(
		{ length: cells.length },
		() => undefined,
	);
	const renderContext: CellRenderContext = {
		runtime,
		signal,
		pythonVariableNames: new Set(Object.keys(options.variables)),
		analysis,
		notebookNames: notebookDefinedNamesFromAnalysis(analysis),
		runtimeCompatibility: options.runtimeCompatibility,
	};
	const syncValues = () => {
		const resolved = resolvedCellModels(cellModels);
		syncNotebookValues(model, resolved);
		if (resolved.length === cells.length && resolved.every((cellModel) => cellModel.get("_has_rendered") === true)) {
			markRendered(model);
		} else {
			markUnrendered(model);
		}
	};
	syncValues();

	const resolutions = composition.cellRefs.map((ref, index) =>
		resolveCellModel(host, ref, signal).then(
			(childModel) => ({ childModel, index }),
			(error: unknown) => ({ error, index }),
		),
	);
	for (const resolution of resolutions) void resolution.then((result) => renderResolvedCell(result));
	await Promise.all(resolutions);
	if (!signal.aborted) {
		syncNotebookGraph(model, notebook, composition.cellKeys, analysis);
		variablesSync.applyInitialViews();
	}
	return resolvedCellModels(cellModels);

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
		onCellResolved(childModel);
		resetRenderReadback(childModel);
		bindResolvedCellModel(childModel);
		const sync = createCellModelSync(childModel, signal, variablesSync);
		renderCellTarget(
			{
				index: resolution.index,
				wrapper,
				cell,
				showSource: options.showSource,
				visible: true,
				sync,
				cellName: sync.model.get("key") || sync.model.get("name"),
			},
			renderContext,
		);
	}

	function bindResolvedCellModel(cellModel: RenderProps<WidgetModel>["model"]): void {
		syncValues();
		cellModel.on("change:_has_rendered", syncValues);
		cellModel.on("change:_value_names", syncValues);
		cellModel.on("change:_values", syncValues);
		signal.addEventListener(
			"abort",
			() => {
				cellModel.off("change:_has_rendered", syncValues);
				cellModel.off("change:_value_names", syncValues);
				cellModel.off("change:_values", syncValues);
			},
			{ once: true },
		);
	}
}

/**
 * Render one child widget directly by projecting its parent notebook runtime
 * into this widget output. Dependency cells are defined in the runtime, but
 * only the requested cell is displayed and synced to the child model.
 */
export function renderStandaloneCellProjection({
	parentModel,
	cellModel,
	root,
	notebook,
	cellIndex,
	analysis,
	runtime,
	options,
	variablesSync,
	signal,
}: RenderStandaloneCellProjectionOptions): void {
	const cells = notebook.cells;
	if (!Number.isInteger(cellIndex) || cellIndex < 0 || cellIndex >= cells.length) {
		throw new Error(`NotebookCell index ${cellIndex} is outside the parent Notebook`);
	}
	resetRenderReadback(cellModel);
	syncNotebookGraph(parentModel, notebook, readNotebookCompositionState(parentModel).cellKeys, analysis);

	const targets = standaloneCellRenderTargets({
		root,
		cells,
		cellIndex,
		cellModel,
		options,
		variablesSync,
		signal,
		analysis,
	});
	renderCellTargets(targets, {
		runtime,
		signal,
		pythonVariableNames: new Set(Object.keys(options.variables)),
		analysis,
		notebookNames: notebookDefinedNamesFromAnalysis(analysis),
		runtimeCompatibility: options.runtimeCompatibility,
	});
	variablesSync.applyInitialViews();
}

function standaloneCellRenderTargets({
	root,
	cells,
	cellIndex,
	cellModel,
	options,
	variablesSync,
	signal,
	analysis,
}: {
	root: HTMLElement;
	cells: readonly Cell[];
	cellIndex: number;
	cellModel: RenderProps<WidgetModel>["model"];
	options: NotebookOptions;
	variablesSync: RuntimeVariablesSync;
	signal: AbortSignal;
	analysis: NotebookAnalysis;
}): CellRenderTarget[] {
	const renderIndexes = notebookDependencyIndexes(analysis, cellIndex);
	const targets: CellRenderTarget[] = [];
	for (let index = 0; index < cells.length; index++) {
		if (!renderIndexes.has(index)) continue;
		const cell = cells[index];
		if (!cell) continue;
		const selected = index === cellIndex;
		const wrapper = appendCellWrapper(root, selected ? { composedCellRef: `standalone:${cellIndex}` } : {});
		if (!selected) {
			wrapper.hidden = true;
			wrapper.setAttribute("aria-hidden", "true");
		}
		targets.push({
			index,
			wrapper,
			cell,
			showSource: selected && options.showSource,
			visible: selected,
			sync: selected ? createCellModelSync(cellModel, signal, variablesSync) : undefined,
			variablesSync: selected ? undefined : variablesSync,
			cellName: selected ? cellModel.get("key") || cellModel.get("name") : undefined,
		});
	}
	return targets;
}

function resolvedCellModels(
	cellModels: Array<RenderProps<WidgetModel>["model"] | undefined>,
): Array<RenderProps<WidgetModel>["model"]> {
	return cellModels.filter((cellModel): cellModel is RenderProps<WidgetModel>["model"] => cellModel !== undefined);
}

function renderCellError(wrapper: HTMLElement, error: unknown): void {
	wrapper.replaceChildren(createTopLevelError(error));
}
