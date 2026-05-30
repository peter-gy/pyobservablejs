import type { InitializeProps, RenderProps } from "@anywidget/types";
import { createAbortController } from "./abort";
import { renderCell } from "./cell-renderer";
import { createTopLevelError, markWidgetShell } from "./dom";
import { renderStandaloneCellWidget } from "./standalone-cell";
import type { CellExports, CellRenderContext, WidgetModel } from "./types";

type CellWidgetMount = {
	el: HTMLElement;
	signal: AbortSignal;
	controller: AbortController | null;
};

type CellWidgetState = {
	contexts: CellRenderContext[];
	mounts: Set<CellWidgetMount>;
	composedRenders: WeakMap<HTMLElement, CellRenderContext>;
};

const cellStates = new WeakMap<RenderProps<WidgetModel>["model"], CellWidgetState>();
const localCellExports = new WeakMap<RenderProps<WidgetModel>["model"], CellExports>();
const cellStateKeys = new WeakMap<RenderProps<WidgetModel>["model"], string>();
const cellStatesById = new Map<string, CellWidgetState>();
const localCellExportsById = new Map<string, CellExports>();
let nextFallbackCellStateKey = 0;

/**
 * Initialize the exports used by a parent notebook to bind a child cell runtime.
 */
export function initializeCellWidget({
	model,
	signal,
}: InitializeProps<WidgetModel> & { signal?: AbortSignal }): CellExports | undefined {
	if (model.get("role") !== "cell") return undefined;
	const key = getCellStateKey(model);
	const exports = ensureLocalCellExports(model);
	signal?.addEventListener(
		"abort",
		() => {
			cellStatesById.delete(key);
			localCellExportsById.delete(key);
		},
		{ once: true },
	);
	return exports;
}

/**
 * Return the cell exports for a model, creating shared state when the child has
 * not run its own initialize hook yet.
 */
export function ensureLocalCellExports(model: RenderProps<WidgetModel>["model"]): CellExports {
	const key = getCellStateKey(model);
	const existingById = localCellExportsById.get(key);
	if (existingById) return existingById;
	const existing = localCellExports.get(model);
	if (existing) return existing;
	const exports = createCellExports(model, getOrCreateCellState(model));
	localCellExportsById.set(key, exports);
	return exports;
}

/**
 * Render a child widget mount either as part of the composed notebook or as a
 * standalone cell access such as `nb.cells[1]`.
 */
export function renderCellWidget(model: RenderProps<WidgetModel>["model"], el: HTMLElement, signal: AbortSignal): void {
	if (signal.aborted) return;
	const state = getOrCreateCellState(model);
	const composedContext = state.composedRenders.get(el);
	if (composedContext) {
		state.composedRenders.delete(el);
		renderComposedCellWidget(el, composedContext, signal);
		return;
	}
	const mount: CellWidgetMount = { el, signal, controller: null };
	state.mounts.add(mount);
	signal.addEventListener(
		"abort",
		() => {
			mount.controller?.abort();
			state.mounts.delete(mount);
		},
		{ once: true },
	);
	renderCellWidgetMount(model, mount);
}

function createCellExports(model: RenderProps<WidgetModel>["model"], state: CellWidgetState): CellExports {
	const exports: CellExports = {
		bindRuntime(context: CellRenderContext) {
			state.contexts = state.contexts.filter((item) => item !== context);
			state.contexts.push(context);
			for (const mount of state.mounts) renderCellWidgetMount(model, mount);
		},
		unbindRuntime(context: CellRenderContext) {
			const contexts = state.contexts.filter((item) => item !== context);
			if (contexts.length === state.contexts.length) return;
			state.contexts = contexts;
			for (const mount of state.mounts) renderCellWidgetMount(model, mount);
		},
		prepareComposedRender(el: HTMLElement, context: CellRenderContext) {
			state.composedRenders.set(el, context);
		},
	};
	localCellExports.set(model, exports);
	return exports;
}

function getOrCreateCellState(model: RenderProps<WidgetModel>["model"]): CellWidgetState {
	const key = getCellStateKey(model);
	const existingById = cellStatesById.get(key);
	if (existingById) return existingById;
	const state = cellStates.get(model) ?? {
		contexts: [],
		mounts: new Set(),
		composedRenders: new WeakMap<HTMLElement, CellRenderContext>(),
	};
	cellStates.set(model, state);
	cellStatesById.set(key, state);
	return state;
}

function getCellStateKey(model: RenderProps<WidgetModel>["model"]): string {
	const syncedId = model.get("_cell_id");
	if (typeof syncedId === "string" && syncedId.length > 0) return syncedId;
	const existing = cellStateKeys.get(model);
	if (existing) return existing;
	const fallback = `local-${++nextFallbackCellStateKey}`;
	cellStateKeys.set(model, fallback);
	return fallback;
}

function renderCellWidgetMount(model: RenderProps<WidgetModel>["model"], mount: CellWidgetMount): void {
	mount.controller?.abort();
	mount.controller = createAbortController(mount.signal);
	const signal = mount.controller.signal;
	const context = currentCellContext(getOrCreateCellState(model));
	if (!context) {
		if (!mount.signal.aborted) mount.el.replaceChildren();
		return;
	}
	try {
		renderStandaloneCellWidget(model, mount.el, context, signal);
	} catch (error) {
		const shouldRenderError = !signal.aborted;
		mount.controller?.abort();
		if (shouldRenderError) mount.el.replaceChildren(createTopLevelError(error));
	}
}

function currentCellContext(state: CellWidgetState): CellRenderContext | null {
	return state.contexts[state.contexts.length - 1] ?? null;
}

function renderComposedCellWidget(el: HTMLElement, context: CellRenderContext, signal: AbortSignal): void {
	markWidgetShell(el);
	if (signal.aborted) return;
	renderCell({
		wrapper: el,
		runtime: context.runtime,
		cell: context.cell,
		showSource: context.showSource,
		sync: context.sync,
		signal,
		cellName: context.sync.model.get("name"),
	});
}
