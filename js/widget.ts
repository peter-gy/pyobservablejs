import type { InitializeProps, RenderProps } from "@anywidget/types";
import { deserialize, toNotebook, transpile, type Cell, type Notebook } from "@observablehq/notebook-kit";
import { observe, type NotebookRuntime } from "@observablehq/notebook-kit/runtime";
import { registerAttachments } from "./attachments";
import { createNotebookGraph, exposedVariableNames, unprefix } from "./graph";
import { renderSource } from "./highlight";
import { createRuntime, createRuntimeCleanup } from "./runtime";
import type {
	CellExports,
	CellRenderContext,
	CellVariableSync,
	CompositionHost,
	NotebookOptions,
	ResolvedCell,
	ResolvedCellWidget,
	RuntimeObserver,
	ViewTarget,
	WidgetModel,
} from "./types";
import { reviveSyncedValue, toWireValue } from "./wire";
import "@observablehq/notebook-kit/index.css";
import "@observablehq/notebook-kit/theme-air.css";
import "./widget.css";

// Notebook models own the Notebook Kit runtime; cell models own per-cell handles
// for rendering and synchronized values.

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

const MODEL_CHANGE_EVENTS = [
	"change:source",
	"change:spec",
	"change:attachments",
	"change:base_url",
	"change:_data",
	"change:options",
	"change:_cell_widgets",
] as const;
const cellStates = new WeakMap<RenderProps<WidgetModel>["model"], CellWidgetState>();
const localCellExports = new WeakMap<RenderProps<WidgetModel>["model"], CellExports>();
const cellStateKeys = new WeakMap<RenderProps<WidgetModel>["model"], string>();
const cellStatesById = new Map<string, CellWidgetState>();
const localCellExportsById = new Map<string, CellExports>();
let nextFallbackCellStateKey = 0;

function initialize({
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

function createCellExports(model: RenderProps<WidgetModel>["model"], state: CellWidgetState): CellExports {
	// Standalone mounts re-render against the latest parent runtime context.
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

function render({ model, el, signal, host }: RenderProps<WidgetModel> & { signal?: AbortSignal }): void {
	signal ??= new AbortController().signal;
	if (signal.aborted) return;
	if (model.get("role") === "cell") {
		renderCellWidget(model, el, signal);
		return;
	}

	let current = createAbortController(signal);
	let version = 0;
	const rerender = () => {
		current.abort();
		current = createAbortController(signal);
		const attempt = current;
		const renderVersion = ++version;
		void renderCurrent(model, el, attempt.signal, host).catch((error: unknown) => {
			if (attempt.signal.aborted || renderVersion !== version) return;
			attempt.abort();
			el.replaceChildren(renderTopLevelError(error));
		});
	};

	for (const event of MODEL_CHANGE_EVENTS) model.on(event, rerender);
	signal.addEventListener(
		"abort",
		() => {
			for (const event of MODEL_CHANGE_EVENTS) model.off(event, rerender);
			current.abort();
		},
		{ once: true },
	);
	rerender();
}

async function renderCurrent(
	model: RenderProps<WidgetModel>["model"],
	el: HTMLElement,
	signal: AbortSignal,
	host: RenderProps<WidgetModel>["host"] | undefined,
): Promise<void> {
	el.replaceChildren();
	el.classList.add("observablejs");
	if (signal.aborted) return;

	const notebook = getNotebook(model);
	const cellRefs = getCellRefs(model.get("_cell_widgets"));
	const compositionHost = host ? createCompositionHost(host) : createWidgetManagerCompositionHost(model, signal);
	if (cellRefs.length > 0) {
		if (!compositionHost) throw new Error("This anywidget host does not expose composition APIs for cell widgets");
		if (cellRefs.length !== notebook.cells.length) {
			throw new Error(`Expected ${notebook.cells.length} cell widgets, received ${cellRefs.length}`);
		}
	} else if (notebook.cells.length > 0) {
		throw new Error(`Expected ${notebook.cells.length} cell widgets, received 0`);
	}
	if (cellRefs.length === 0) {
		syncNotebookGraph(model, notebook);
		syncNotebookValues(model, []);
	}

	const root = document.createElement("div");
	root.className = "observablejs-notebook observablehq observablehq--block";
	root.dataset.theme = typeof notebook.theme === "string" ? notebook.theme : "light-dark";
	el.appendChild(root);

	const options = getNotebookOptions(model);
	const attachmentRegistry = registerAttachments(options.attachments);
	const runtime = createRuntime(root, el, options, attachmentRegistry);
	const cleanup = createRuntimeCleanup(runtime, attachmentRegistry);
	signal.addEventListener("abort", cleanup, { once: true });

	try {
		if (cellRefs.length > 0 && compositionHost) {
			await renderComposedCells(model, root, notebook, cellRefs, runtime, options, signal, compositionHost);
		}
	} catch (error) {
		if (!signal.aborted) cleanup();
		throw error;
	}
}

function createCompositionHost(host: RenderProps<WidgetModel>["host"]): CompositionHost {
	return {
		getModel(ref) {
			return host.getModel<WidgetModel>(ref);
		},
		async getWidget(ref) {
			return host.getWidget<CellExports>(ref);
		},
	};
}

function createWidgetManagerCompositionHost(
	model: RenderProps<WidgetModel>["model"],
	signal: AbortSignal,
): CompositionHost | undefined {
	const manager = model.widget_manager as
		| { get_model?: (modelId: string) => Promise<RenderProps<WidgetModel>["model"]> }
		| undefined;
	if (!manager?.get_model) return undefined;

	const host: CompositionHost = {
		async getModel(ref) {
			const modelId = parseWidgetRef(ref);
			const childModel = await manager.get_model?.(modelId);
			if (!childModel) throw new Error(`Unknown widget model ${modelId}`);
			return childModel;
		},
		async getWidget(ref) {
			const childModel = await host.getModel(ref);
			return {
				exports: ensureLocalCellExports(childModel),
				async render({ el, signal: childSignal }) {
					render({
						model: childModel,
						el,
						signal: childSignal ?? signal,
						host,
					} as RenderProps<WidgetModel>);
				},
			};
		},
	};
	return host;
}

function ensureLocalCellExports(model: RenderProps<WidgetModel>["model"]): CellExports {
	const key = getCellStateKey(model);
	const existingById = localCellExportsById.get(key);
	if (existingById) return existingById;
	const existing = localCellExports.get(model);
	if (existing) return existing;
	const exports = createCellExports(model, getOrCreateCellState(model));
	localCellExportsById.set(key, exports);
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

function parseWidgetRef(ref: string): string {
	if (typeof ref !== "string" || !ref.startsWith("anywidget:")) {
		throw new Error(`Malformed widget reference: ${String(ref)}`);
	}
	const modelId = ref.slice("anywidget:".length);
	if (!modelId) throw new Error(`Malformed widget reference: ${String(ref)}`);
	return modelId;
}

function getNotebook(model: RenderProps<WidgetModel>["model"]): Notebook {
	const source = model.get("source");
	if (source?.trim()) return deserialize(source);
	return toNotebook(model.get("spec") ?? {});
}

function getNotebookOptions(model: RenderProps<WidgetModel>["model"]): NotebookOptions {
	return {
		attachments: model.get("attachments") ?? {},
		baseUrl: model.get("base_url") || document.baseURI,
		data: model.get("_data") ?? {},
		showSource: model.get("options")?.show_source === true,
	};
}

async function renderComposedCells(
	model: RenderProps<WidgetModel>["model"],
	root: HTMLElement,
	notebook: Notebook,
	cellRefs: string[],
	runtime: NotebookRuntime,
	options: NotebookOptions,
	signal: AbortSignal,
	host: CompositionHost,
): Promise<void> {
	// One Notebook Kit runtime, one child widget model per cell.
	const cells = notebook.cells;
	const wrappers = cells.map((_, index) => {
		const wrapper = appendCellWrapper(root);
		wrapper.dataset.observablejsComposed = "true";
		wrapper.dataset.observablejsCellRef = cellRefs[index] ?? "";
		return wrapper;
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
		const sync = createCellModelSync(childModel, signal);
		const context: CellRenderContext = {
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
}

async function resolveCellWidget(host: CompositionHost, ref: string, signal: AbortSignal): Promise<ResolvedCell> {
	// Some hosts expose the child model before the child widget exports are
	// ready. Retry briefly so initial notebook display does not depend on host
	// scheduling details.
	parseWidgetRef(ref);
	return resolveCellWidgetAttempt(host, ref, signal, performance.now() + 5000);
}

async function resolveCellWidgetAttempt(
	host: CompositionHost,
	ref: string,
	signal: AbortSignal,
	deadline: number,
	lastError?: unknown,
): Promise<ResolvedCell> {
	if (signal.aborted || performance.now() >= deadline) {
		throw lastError ?? new Error(`Unable to resolve cell widget ${ref}`);
	}
	let child: ResolvedCellWidget;
	let childModel: RenderProps<WidgetModel>["model"];
	try {
		[child, childModel] = await Promise.all([host.getWidget(ref), host.getModel(ref)]);
	} catch (error) {
		if (!isRetryableResolutionError(error)) throw error;
		await delay(75, signal);
		return resolveCellWidgetAttempt(host, ref, signal, deadline, error);
	}
	if (!isCellExports(child.exports)) {
		throw new Error(`Cell widget ${ref} does not expose observablejs cell exports`);
	}
	return [child, childModel];
}

function isRetryableResolutionError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return /not ready|not found|no binding found|unknown widget model|model .*missing|widget .*missing|no model/i.test(
		error.message,
	);
}

function isCellExports(value: unknown): value is CellExports {
	if (value === null || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.bindRuntime === "function" &&
		typeof candidate.unbindRuntime === "function" &&
		typeof candidate.prepareComposedRender === "function"
	);
}

function renderCellWidget(model: RenderProps<WidgetModel>["model"], el: HTMLElement, signal: AbortSignal): void {
	// Direct child renders wait until the parent binds a runtime context.
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

function renderCellWidgetMount(model: RenderProps<WidgetModel>["model"], mount: CellWidgetMount): void {
	mount.controller?.abort();
	mount.controller = createAbortController(mount.signal);
	const signal = mount.controller.signal;
	const context = currentCellContext(getOrCreateCellState(model));
	if (!context) {
		mount.el.replaceChildren();
		return;
	}
	try {
		renderStandaloneCellWidget(model, mount.el, context, signal);
	} catch (error) {
		const shouldRenderError = !signal.aborted;
		mount.controller?.abort();
		if (shouldRenderError) mount.el.replaceChildren(renderTopLevelError(error));
	}
}

function currentCellContext(state: CellWidgetState): CellRenderContext | null {
	return state.contexts[state.contexts.length - 1] ?? null;
}

function renderStandaloneCellWidget(
	model: RenderProps<WidgetModel>["model"],
	el: HTMLElement,
	context: CellRenderContext,
	signal: AbortSignal,
): void {
	const definition = transpile(context.cell, { resolveLocalImports: true });
	if (definition.autoview === true) {
		renderIsolatedStandaloneCellWidget(model, el, context, signal);
		return;
	}
	renderLiveStandaloneCellWidget(model, el, context, definition, signal);
}

function renderLiveStandaloneCellWidget(
	model: RenderProps<WidgetModel>["model"],
	el: HTMLElement,
	context: CellRenderContext,
	definition: ReturnType<typeof transpile>,
	signal: AbortSignal,
): void {
	el.replaceChildren();
	el.classList.add("observablejs");
	if (signal.aborted) return;

	const root = document.createElement("div");
	root.className = "observablejs-notebook observablehq observablehq--block";
	root.dataset.theme = typeof context.notebook.theme === "string" ? context.notebook.theme : "light-dark";
	el.appendChild(root);

	const wrapper = appendCellWrapper(root);
	wrapper.dataset.observablejsStandaloneCell = "true";
	const output = document.createElement("div");
	output.id = `cell-${context.cell.id}`;
	output.className = "observablehq observablehq--cell";
	wrapper.appendChild(output);

	syncCellVariableNames(model, exposedVariableNames(definition));
	const state: Parameters<NotebookRuntime["define"]>[0] = {
		root: output,
		expanded: [],
		variables: [],
	};
	signal.addEventListener(
		"abort",
		() => {
			for (const variable of state.variables) variable.delete();
			output.replaceChildren();
		},
		{ once: true },
	);
	try {
		context.runtime.define(state, createStandaloneDisplayDefinition(context.cell, definition), observe);
		if (context.showSource && context.cell.pinned) {
			wrapper.appendChild(renderSource(context.cell, signal));
		}
	} catch (error) {
		if (!signal.aborted) {
			for (const variable of state.variables) variable.delete();
		}
		throw error;
	}
}

function renderIsolatedStandaloneCellWidget(
	model: RenderProps<WidgetModel>["model"],
	el: HTMLElement,
	context: CellRenderContext,
	signal: AbortSignal,
): void {
	el.replaceChildren();
	el.classList.add("observablejs");
	if (signal.aborted) return;

	const root = document.createElement("div");
	root.className = "observablejs-notebook observablehq observablehq--block";
	root.dataset.theme = typeof context.notebook.theme === "string" ? context.notebook.theme : "light-dark";
	el.appendChild(root);

	const attachmentRegistry = registerAttachments(context.options.attachments);
	const runtime = createRuntime(root, el, context.options, attachmentRegistry);
	const cleanup = createRuntimeCleanup(runtime, attachmentRegistry);
	signal.addEventListener("abort", cleanup, { once: true });

	try {
		defineStandaloneDependencyVariables(runtime, context, signal);
		const wrapper = appendCellWrapper(root);
		wrapper.dataset.observablejsStandaloneCell = "true";
		renderCell(wrapper, runtime, context.cell, context.showSource, createCellModelSync(model, signal), signal);
	} catch (error) {
		if (!signal.aborted) cleanup();
		throw error;
	}
}

function renderComposedCellWidget(el: HTMLElement, context: CellRenderContext, signal: AbortSignal): void {
	el.classList.add("observablejs");
	if (signal.aborted) return;
	renderCell(el, context.runtime, context.cell, context.showSource, context.sync, signal);
}

function defineStandaloneDependencyVariables(
	runtime: NotebookRuntime,
	context: CellRenderContext,
	signal: AbortSignal,
): void {
	// Isolated `viewof` renders revive dependency values from sibling cell traits.
	const cleanups: Array<() => void> = [];
	try {
		const definition = transpile(context.cell, { resolveLocalImports: true });
		const inputs = new Set(definition.inputs ?? []);
		for (let index = 0; index < context.cellModels.length; index++) {
			if (index === context.cellIndex) continue;
			const model = context.cellModels[index];
			if (!model) continue;
			const sibling = context.notebook.cells[index];
			if (!sibling) continue;
			for (const name of exposedVariableNames(transpile(sibling, { resolveLocalImports: true }))) {
				if (!inputs.has(name)) continue;
				if (runtime.main.defines(name)) continue;
				const variable = runtime.main.variable(true);
				const defineCurrent = () => {
					variable.define(name, [], () => reviveSyncedValue(model.get("variables")?.[name]));
				};
				const cleanup = () => model.off("change:variables", defineCurrent);
				defineCurrent();
				model.on("change:variables", defineCurrent);
				signal.addEventListener("abort", cleanup, { once: true });
				cleanups.push(() => {
					signal.removeEventListener("abort", cleanup);
					cleanup();
				});
			}
		}
	} catch (error) {
		for (const cleanup of cleanups.reverse()) cleanup();
		throw error;
	}
}

function appendCellWrapper(root: HTMLElement): HTMLElement {
	const wrapper = document.createElement("div");
	wrapper.className = "observablejs-cell";
	root.appendChild(wrapper);
	return wrapper;
}

function renderCell(
	wrapper: HTMLElement,
	runtime: NotebookRuntime,
	cell: Cell,
	showSource: boolean,
	sync: CellVariableSync | undefined,
	signal: AbortSignal,
): void {
	wrapper.replaceChildren();
	const output = document.createElement("div");
	output.id = `cell-${cell.id}`;
	output.className = "observablehq observablehq--cell";
	wrapper.appendChild(output);
	defineCell(runtime, output, cell, sync);

	if (showSource && cell.pinned) {
		wrapper.appendChild(renderSource(cell, signal));
	}
}

function defineCell(runtime: NotebookRuntime, root: HTMLDivElement, cell: Cell, sync?: CellVariableSync): void {
	try {
		const definition = transpile(cell, { resolveLocalImports: true });
		const exposed = exposedVariableNames(definition);
		sync?.setVariableNames(exposed);
		runtime.define(
			{
				root,
				expanded: [],
				variables: [],
			},
			createRuntimeDefinition(cell, definition),
			sync ? createCellObserver(sync, definition) : observe,
		);
		for (const name of exposed) {
			if (sync) {
				runtime.main.variable(createSyncObserver(sync, name)).define([name], (value: unknown) => value);
			}
		}
		if (sync) applyModelVariablesToViews(sync);
	} catch (error) {
		root.appendChild(renderTopLevelError(error));
	}
}

function createRuntimeDefinition(
	cell: Cell,
	definition: ReturnType<typeof transpile>,
): Parameters<NotebookRuntime["define"]>[1] {
	return {
		id: cell.id,
		body: new Function(`return (${definition.body});`)(),
		inputs: definition.inputs,
		outputs: definition.outputs,
		output: definition.output,
		autodisplay: definition.autodisplay,
		autoview: definition.autoview,
		automutable: definition.automutable,
	};
}

function createStandaloneDisplayDefinition(
	cell: Cell,
	definition: ReturnType<typeof transpile>,
): Parameters<NotebookRuntime["define"]>[1] {
	return {
		id: cell.id,
		body: new Function(`return (${definition.body});`)(),
		inputs: definition.inputs,
		autodisplay: definition.autodisplay,
	};
}

function renderCellError(wrapper: HTMLElement, error: unknown): void {
	wrapper.replaceChildren(renderTopLevelError(error));
}

function createCellObserver(sync: CellVariableSync, definition: ReturnType<typeof transpile>): typeof observe {
	// `viewof x` returns the DOM/control target, while `x` is the current value.
	// Capture the target so later Python writes can update the rendered control.
	return (state, runtimeDefinition) => {
		const observer = observe(state, runtimeDefinition);
		const fulfilled = observer.fulfilled.bind(observer);
		observer.fulfilled = (value: unknown) => {
			const viewName = viewVariableName(definition);
			if (viewName) registerView(sync, viewName, value);
			fulfilled(value);
		};
		return observer;
	};
}

function createSyncObserver(sync: CellVariableSync, name: string): RuntimeObserver {
	return {
		pending() {},
		fulfilled(value: unknown) {
			sync.setVariable(name, toWireValue(value));
		},
		rejected(error: unknown) {
			sync.setVariable(name, toWireValue(error));
		},
	};
}

function viewVariableName(definition: ReturnType<typeof transpile>): string | null {
	if (!definition.autoview || !definition.output) return null;
	return unprefix(definition.output, "viewof$");
}

function registerView(sync: CellVariableSync, name: string, value: unknown): void {
	if (!isViewTarget(value)) return;
	sync.views.set(name, value);
	applyModelVariablesToViews(sync);
	sync.signal.addEventListener(
		"abort",
		() => {
			sync.views.delete(name);
		},
		{ once: true },
	);
}

function isViewTarget(value: unknown): value is ViewTarget {
	return value instanceof EventTarget && "value" in value;
}

function createCellModelSync(model: RenderProps<WidgetModel>["model"], signal: AbortSignal): CellVariableSync {
	// Cell models expose OJS state to Python through `variable_names` and `variables`.
	const sync = createBaseSync(model, signal, {
		readNames: () => model.get("variable_names") ?? [],
		writeNames: (names) => {
			model.set("variable_names", names);
			model.save_changes();
		},
		readVariables: () => readModelVariables(model),
		writeVariables: (variables) => {
			model.set("variables", variables);
			model.save_changes();
		},
		changeEvent: "change:variables",
	});
	return sync;
}

function syncCellVariableNames(model: RenderProps<WidgetModel>["model"], names: string[]): void {
	if (sameWireValue(model.get("variable_names"), names)) return;
	model.set("variable_names", names);
	model.save_changes();
}

function createBaseSync(
	model: RenderProps<WidgetModel>["model"],
	signal: AbortSignal,
	adapter: {
		readNames(): string[];
		writeNames(names: string[]): void;
		readVariables(): Record<string, unknown>;
		writeVariables(variables: Record<string, unknown>): void;
		changeEvent: string;
	},
): CellVariableSync {
	const sync: CellVariableSync = {
		model,
		signal,
		views: new Map(),
		setVariableNames(names) {
			if (sameWireValue(adapter.readNames(), names)) return;
			adapter.writeNames(names);
		},
		setVariable(name, value) {
			const variables = adapter.readVariables();
			if (sameWireValue(variables[name], value)) return;
			adapter.writeVariables({ ...variables, [name]: value });
		},
		currentVariables: adapter.readVariables,
	};
	const apply = () => applyModelVariablesToViews(sync);
	model.on(adapter.changeEvent, apply);
	signal.addEventListener("abort", () => model.off(adapter.changeEvent, apply), { once: true });
	return sync;
}

function applyModelVariablesToViews(sync: CellVariableSync): void {
	// Python writes to `variables` update backing `viewof` controls.
	for (const [name, wireValue] of Object.entries(sync.currentVariables())) {
		const view = sync.views.get(name);
		if (!view) continue;
		if (sameWireValue(toWireValue(readViewValue(view)), wireValue)) continue;
		writeViewValue(view, reviveSyncedValue(wireValue));
	}
}

function readViewValue(view: ViewTarget): unknown {
	if (view instanceof HTMLInputElement) {
		if (view.type === "checkbox") return view.checked;
		if (view.type === "number" || view.type === "range") return view.valueAsNumber;
		return view.value;
	}
	if (view instanceof HTMLSelectElement && view.multiple) {
		return Array.from(view.selectedOptions, (option) => option.value);
	}
	return view.value;
}

function writeViewValue(view: ViewTarget, value: unknown): void {
	if (view instanceof HTMLInputElement) {
		if (view.type === "checkbox") {
			view.checked = Boolean(value);
			view.value = String(value);
			view.dispatchEvent(new Event("click", { bubbles: true }));
		} else if (view.type === "date" && value instanceof Date) {
			view.value = value.toISOString().slice(0, 10);
		} else if (view.type === "datetime-local" && value instanceof Date) {
			view.value = value.toISOString().slice(0, 16);
		} else {
			view.value = value == null ? "" : String(value);
		}
	} else if (view instanceof HTMLSelectElement && view.multiple && Array.isArray(value)) {
		const selected = new Set(value.map(String));
		for (const option of view.options) option.selected = selected.has(option.value);
	} else {
		view.value = value;
	}
	view.dispatchEvent(new Event("input", { bubbles: true }));
	view.dispatchEvent(new Event("change", { bubbles: true }));
}

function sameWireValue(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function syncNotebookGraph(
	model: RenderProps<WidgetModel>["model"],
	notebook: Notebook,
	cellModels: Array<RenderProps<WidgetModel>["model"]> = [],
): void {
	const names = cellModels.map((cellModel) => cellModel?.get("name") ?? "");
	const graph = createNotebookGraph(notebook, names);
	if (!sameWireValue(model.get("_graph"), graph)) {
		model.set("_graph", graph);
		model.save_changes();
	}
}

function bindNotebookValueSync(
	model: RenderProps<WidgetModel>["model"],
	cellModels: Array<RenderProps<WidgetModel>["model"]>,
	signal: AbortSignal,
): void {
	const sync = () => syncNotebookValues(model, cellModels);
	sync();
	for (const cellModel of cellModels) {
		cellModel.on("change:variable_names", sync);
		cellModel.on("change:variables", sync);
	}
	signal.addEventListener(
		"abort",
		() => {
			for (const cellModel of cellModels) {
				cellModel.off("change:variable_names", sync);
				cellModel.off("change:variables", sync);
			}
		},
		{ once: true },
	);
}

function syncNotebookValues(
	model: RenderProps<WidgetModel>["model"],
	cellModels: Array<RenderProps<WidgetModel>["model"]>,
): void {
	const names: string[] = [];
	const variables: Record<string, unknown> = {};
	for (const cellModel of cellModels) {
		for (const name of readModelVariableNames(cellModel)) {
			if (!names.includes(name)) names.push(name);
		}
		for (const [name, value] of Object.entries(readModelVariables(cellModel))) {
			if (!names.includes(name)) names.push(name);
			variables[name] = value;
		}
	}
	let changed = false;
	if (!sameWireValue(model.get("variable_names"), names)) {
		model.set("variable_names", names);
		changed = true;
	}
	if (!sameWireValue(model.get("variables"), variables)) {
		model.set("variables", variables);
		changed = true;
	}
	if (changed) model.save_changes();
}

function readModelVariableNames(model: RenderProps<WidgetModel>["model"]): string[] {
	const value = model.get("variable_names");
	return Array.isArray(value) ? value.filter((name): name is string => typeof name === "string") : [];
}

function readModelVariables(model: RenderProps<WidgetModel>["model"]): Record<string, unknown> {
	const value = model.get("variables");
	if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
	return value;
}

function getCellRefs(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

function renderTopLevelError(error: unknown): HTMLElement {
	const pre = document.createElement("pre");
	pre.className = "observablejs-error";
	pre.textContent = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	return pre;
}

function createAbortController(parent: AbortSignal): AbortController {
	const controller = new AbortController();
	const abort = () => controller.abort();
	if (parent.aborted) {
		controller.abort();
	} else {
		parent.addEventListener("abort", abort, { once: true });
		controller.signal.addEventListener("abort", () => parent.removeEventListener("abort", abort), {
			once: true,
		});
	}
	return controller;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const timeout = window.setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				window.clearTimeout(timeout);
				resolve();
			},
			{ once: true },
		);
	});
}

export default { initialize, render };
