import type { RenderProps } from "@anywidget/types";
import type { Cell, Notebook } from "@observablehq/notebook-kit";
import { observe, type NotebookRuntime } from "@observablehq/notebook-kit/runtime";
import {
	exposedVariableNames,
	transpileNotebookCell,
	unprefix,
	type CellAnalysis,
	type NotebookAnalysis,
	type RuntimeCellDefinition,
} from "@/runtime/graph";
import {
	createRuntimeDefinition,
	runtimeDocument,
	toWireValue,
	type NotebookOptions,
	type RuntimeVariablesSync,
} from "@/runtime";
import { appendCellWrapper, createCellOutput, createTopLevelError, renderSource } from "./dom";
import {
	applyModelVariablesToViews,
	createCellModelSync,
	markRendered,
	markUnrendered,
	readCellKeys,
	registerView,
	resetRenderReadback,
	syncNotebookGraph,
	syncNotebookValues,
	type CellVariableSync,
	type WidgetModel,
} from "./state";

const MODEL_LOOKUP_TIMEOUT_MS = 1_000;
const MODEL_LOOKUP_RETRY_MS = 25;

type RenderCellOptions = {
	wrapper: HTMLElement;
	runtime: NotebookRuntime;
	cell: Cell;
	showSource: boolean;
	sync?: CellVariableSync;
	signal: AbortSignal;
	cellName?: string;
	pythonVariableNames?: Set<string>;
	analysis?: CellAnalysis;
};
type RuntimeDefinition = Parameters<NotebookRuntime["define"]>[1];
type RuntimeObserver = Parameters<NotebookRuntime["main"]["variable"]>[0];
type DefinitionInput = { definition: RuntimeCellDefinition } | { error: unknown };

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
	cellKeys: readonly string[],
): Promise<void> {
	const cells = notebook.cells;
	const wrappers = cells.map((_, index) => {
		return appendCellWrapper(root, { composedCellRef: cellRefs[index] ?? "" });
	});
	const cellModels: Array<RenderProps<WidgetModel>["model"] | undefined> = Array.from(
		{ length: cells.length },
		() => undefined,
	);
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

	const resolutions = cellRefs.map((ref, index) =>
		resolveCellModel(host, ref, signal).then(
			(childModel) => ({ childModel, index }),
			(error: unknown) => ({ error, index }),
		),
	);
	for (const resolution of resolutions) void resolution.then((result) => renderResolvedCell(result));
	await Promise.all(resolutions);
	if (!signal.aborted) {
		syncNotebookGraph(model, notebook, cellKeys, analysis);
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
		resetRenderReadback(childModel);
		bindResolvedCellModel(childModel);
		const sync = createCellModelSync(childModel, signal, variablesSync);
		renderCell({
			wrapper,
			runtime,
			cell,
			showSource: options.showSource,
			sync,
			signal,
			cellName: sync.model.get("key") || sync.model.get("name"),
			pythonVariableNames: new Set(Object.keys(options.variables)),
			analysis: analysis.cells[resolution.index],
		});
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
export function renderStandaloneCellProjection(
	parentModel: RenderProps<WidgetModel>["model"],
	cellModel: RenderProps<WidgetModel>["model"],
	root: HTMLElement,
	notebook: Notebook,
	cellIndex: number,
	analysis: NotebookAnalysis,
	runtime: NotebookRuntime,
	options: NotebookOptions,
	variablesSync: RuntimeVariablesSync,
	signal: AbortSignal,
): void {
	const cells = notebook.cells;
	if (!Number.isInteger(cellIndex) || cellIndex < 0 || cellIndex >= cells.length) {
		throw new Error(`NotebookCell index ${cellIndex} is outside the parent Notebook`);
	}
	resetRenderReadback(cellModel);
	syncNotebookGraph(parentModel, notebook, readCellKeys(parentModel), analysis);

	const renderIndexes = standaloneRenderIndexes(analysis, cellIndex);
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
		const sync = selected ? createCellModelSync(cellModel, signal, variablesSync) : undefined;
		renderCell({
			wrapper,
			runtime,
			cell,
			showSource: selected && options.showSource,
			sync,
			signal,
			cellName: selected ? cellModel.get("key") || cellModel.get("name") : undefined,
			pythonVariableNames: new Set(Object.keys(options.variables)),
			analysis: analysis.cells[index],
		});
	}
	variablesSync.applyInitialViews();
}

function standaloneRenderIndexes(analysis: NotebookAnalysis, cellIndex: number): Set<number> {
	const indexById = new Map(analysis.graph.cells.map((cell) => [cell.id, cell.index]));
	const sourceIndexesByTarget = new Map<number, number[]>();
	for (const edge of analysis.graph.edges) {
		const sourceIndex = indexById.get(edge.from);
		const targetIndex = indexById.get(edge.to);
		if (sourceIndex === undefined || targetIndex === undefined) continue;
		const sources = sourceIndexesByTarget.get(targetIndex);
		if (sources) sources.push(sourceIndex);
		else sourceIndexesByTarget.set(targetIndex, [sourceIndex]);
	}
	const indexes = new Set<number>();
	const visit = (index: number) => {
		if (indexes.has(index)) return;
		indexes.add(index);
		for (const sourceIndex of sourceIndexesByTarget.get(index) ?? []) visit(sourceIndex);
	};
	visit(cellIndex);
	return indexes;
}

function resolvedCellModels(
	cellModels: Array<RenderProps<WidgetModel>["model"] | undefined>,
): Array<RenderProps<WidgetModel>["model"]> {
	return cellModels.filter((cellModel): cellModel is RenderProps<WidgetModel>["model"] => cellModel !== undefined);
}

function renderCell({
	wrapper,
	runtime,
	cell,
	showSource,
	sync,
	signal,
	cellName,
	pythonVariableNames,
	analysis,
}: RenderCellOptions): void {
	wrapper.replaceChildren();
	const output = createCellOutput(wrapper, cell);
	defineCell(runtime, output, cell, sync, cellName, pythonVariableNames, definitionInputFromAnalysis(analysis));

	if (showSource && cell.pinned) {
		appendSource(wrapper, cell, signal);
	}
}

function defineCell(
	runtime: NotebookRuntime,
	root: HTMLDivElement,
	cell: Cell,
	sync?: CellVariableSync,
	cellName?: string,
	pythonVariableNames: Set<string> = new Set(),
	definitionInput?: DefinitionInput,
): void {
	try {
		const definition = readDefinition(cell, definitionInput);
		const exposed = exposedVariableNames(definition);
		const displayName = exposed.length === 0 && cellName ? cellName : null;
		const pythonNames = pythonOwnedNames(definition, exposed, pythonVariableNames);
		sync?.setVariableNames(displayName ? [displayName] : exposed);
		if (sync && pythonNames.length === exposed.length && pythonNames.length > 0) {
			renderPythonVariableCell(runtime, root, cell, definition, pythonNames);
			defineSyncObservers(runtime, sync, exposed);
			applyModelVariablesToViews(sync);
			return;
		}
		const sourceDefinition = sourceRuntimeDefinition(definition, pythonNames);
		runtime.define(
			{
				root,
				expanded: [],
				variables: [],
			},
			createRuntimeDefinition(cell, sourceDefinition, { document: runtimeDocument(runtime) }),
			sync ? createCellObserver(sync, sourceDefinition, displayName, exposed.length > 0) : observe,
		);
		if (sync) defineSyncObservers(runtime, sync, exposed);
		if (sync) applyModelVariablesToViews(sync);
	} catch (error) {
		root.appendChild(createTopLevelError(error));
		if (sync) markRendered(sync.model);
	}
}

function renderCellError(wrapper: HTMLElement, error: unknown): void {
	wrapper.replaceChildren(createTopLevelError(error));
}

function appendSource(wrapper: HTMLElement, cell: Cell, signal: AbortSignal): void {
	try {
		if (!signal.aborted) wrapper.appendChild(renderSource(cell, signal));
	} catch (error) {
		if (!signal.aborted) wrapper.appendChild(createTopLevelError(error));
	}
}

function renderPythonVariableCell(
	runtime: NotebookRuntime,
	root: HTMLDivElement,
	cell: Cell,
	sourceDefinition: RuntimeCellDefinition,
	names: string[],
): void {
	const definition: RuntimeDefinition = {
		id: cell.id,
		body: (...values: unknown[]) =>
			names.length === 1 ? values[0] : Object.fromEntries(names.map((name, index) => [name, values[index]])),
		inputs: names,
		outputs: [],
		output: undefined,
		autodisplay: sourceDefinition.autodisplay,
		autoview: false,
		automutable: false,
	};
	runtime.define(
		{
			root,
			expanded: [],
			variables: [],
		},
		definition,
		observe,
	);
}

function definitionInputFromAnalysis(analysis: CellAnalysis | undefined): DefinitionInput | undefined {
	if (!analysis) return undefined;
	if (analysis.definition) return { definition: analysis.definition };
	return { error: analysis.error };
}

function readDefinition(cell: Cell, input: DefinitionInput | undefined): RuntimeCellDefinition {
	if (!input) return transpileNotebookCell(cell);
	if ("definition" in input) return input.definition;
	throw input.error;
}

function createCellObserver(
	sync: CellVariableSync,
	definition: RuntimeCellDefinition,
	displayName: string | null,
	hasSyncedNames: boolean,
): typeof observe {
	const displayObserverCompletesReadback = displayName !== null || !hasSyncedNames;
	return (state, runtimeDefinition) => {
		const observer = observe(state, runtimeDefinition);
		const fulfilled = observer.fulfilled.bind(observer);
		observer.fulfilled = (value: unknown) => {
			const viewName = viewVariableName(definition);
			if (viewName) registerView(sync, viewName, value);
			if (displayName) sync.setVariable(displayName, toWireValue(value));
			if (displayObserverCompletesReadback) markRendered(sync.model);
			fulfilled(value);
		};
		const rejected = observer.rejected.bind(observer);
		observer.rejected = (error: unknown) => {
			if (displayName) sync.setVariable(displayName, toWireValue(error));
			if (displayObserverCompletesReadback) markRendered(sync.model);
			rejected(error);
		};
		return observer;
	};
}

function createSyncObserver(sync: CellVariableSync, name: string, onSettled: () => void): RuntimeObserver {
	let settled = false;
	const settle = () => {
		if (settled) return;
		settled = true;
		onSettled();
	};
	return {
		pending() {},
		fulfilled(value: unknown) {
			sync.setVariable(name, toWireValue(value));
			settle();
		},
		rejected(error: unknown) {
			sync.setVariable(name, toWireValue(error));
			settle();
		},
	};
}

function defineSyncObservers(runtime: NotebookRuntime, sync: CellVariableSync, names: string[]): void {
	const pending = new Set(names);
	const settle = (name: string) => {
		pending.delete(name);
		if (pending.size === 0) markRendered(sync.model);
	};
	for (const name of names) {
		runtime.main.variable(createSyncObserver(sync, name, () => settle(name))).define([name], (value: unknown) => value);
	}
}

function pythonOwnedNames(
	definition: RuntimeCellDefinition,
	exposed: string[],
	pythonVariableNames: Set<string>,
): string[] {
	if (definition.autoview || definition.automutable) return [];
	return exposed.filter((name) => pythonVariableNames.has(name));
}

function sourceRuntimeDefinition(
	definition: RuntimeCellDefinition,
	pythonNames: readonly string[],
): RuntimeCellDefinition {
	if (!definition.outputs || pythonNames.length === 0) return definition;
	const pythonNameSet = new Set(pythonNames);
	return {
		...definition,
		outputs: definition.outputs.filter((name) => !pythonNameSet.has(name)),
	};
}

function viewVariableName(definition: RuntimeCellDefinition): string | null {
	if (!definition.autoview || !definition.output) return null;
	return unprefix(definition.output, "viewof$");
}
