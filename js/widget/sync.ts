import type { RenderProps } from "@anywidget/types";
import type { Notebook } from "@observablehq/notebook-kit";
import type { NotebookRuntime } from "@observablehq/notebook-kit/runtime";
import { createNotebookGraph } from "../notebook/graph";
import {
	isViewTarget,
	readNestedSelectState,
	readViewValue,
	revivePythonValue,
	reviveSyncedValue,
	sameWireValue,
	setRuntimeVariables,
	toWireValue,
	writeViewValue as writeRawViewValue,
	type NestedSelectState,
	type NotebookOptions,
	type RuntimeVariablesSync,
	type ViewTarget,
} from "../runtime";
import { readModelVariableNames, readModelVariables, type WidgetModel } from "./model";

type ModelViewState = {
	selects: NestedSelectState;
	value: unknown;
};

type ModelValueOrigin = "default" | "interaction";

type RuntimeVariablesSyncOptions = {
	model: RenderProps<WidgetModel>["model"];
	runtime: NotebookRuntime;
	options: NotebookOptions;
	viewNames: Set<string>;
	signal: AbortSignal;
	onReset(variables: Record<string, unknown>): void;
	writeViewValue?(view: ViewTarget, value: unknown): boolean;
};

export type CellVariableSync = {
	model: RenderProps<WidgetModel>["model"];
	signal: AbortSignal;
	variablesSync?: RuntimeVariablesSync;
	views: Map<string, ViewTarget>;
	viewCleanups: Map<string, () => void>;
	setVariableNames(names: string[]): void;
	setVariable(name: string, value: unknown): void;
	currentVariables(): Record<string, unknown>;
};

const modelViewStates = new WeakMap<RenderProps<WidgetModel>["model"], Map<string, ModelViewState>>();
const externalModelValues = new WeakMap<RenderProps<WidgetModel>["model"], Set<string>>();
const modelValueOrigins = new WeakMap<RenderProps<WidgetModel>["model"], Map<string, ModelValueOrigin>>();
const pendingViewInteractions = new WeakMap<RenderProps<WidgetModel>["model"], Set<string>>();
const programmaticViewWrites = new WeakSet<ViewTarget>();

/**
 * Create the sync adapter that publishes cell output names and wire values to
 * the child anywidget model.
 */
export function createCellModelSync(
	model: RenderProps<WidgetModel>["model"],
	signal: AbortSignal,
	variablesSync?: RuntimeVariablesSync,
): CellVariableSync {
	const sync = createBaseSync(model, signal, {
		readNames: () => model.get("_value_names") ?? [],
		writeNames: (names) => {
			model.set("_value_names", names);
			model.save_changes();
		},
		readVars: () => readModelVariables(model),
		writeVars: (variables) => {
			model.set("_values", variables);
			model.save_changes();
		},
		changeEvent: "change:_values",
	});
	sync.variablesSync = variablesSync;
	return sync;
}

/**
 * Bind an Observable `viewof` target to Python-visible model state.
 *
 * A replacement view receives saved state only when Python or a browser
 * interaction still owns that value.
 */
export function registerView(sync: CellVariableSync, name: string, value: unknown): void {
	if (!isViewTarget(value)) return;
	const previous = sync.views.get(name);
	if (previous === value) {
		sync.variablesSync?.setView(name, value);
		applyModelVariablesToViews(sync);
		return;
	}
	sync.viewCleanups.get(name)?.();
	sync.views.set(name, value);
	sync.variablesSync?.setView(name, value, () => {
		clearExternalModelValue(sync, name);
		clearModelValueOrigin(sync, name);
	});
	if (hasExternalModelValue(sync, name) || readModelValueOrigin(sync, name) === "interaction") {
		applyModelVariablesToViews(sync);
	}
	const markInteraction = () => {
		if (!isProgrammaticViewWrite(value)) markViewInteraction(sync, name);
	};
	value.addEventListener("input", markInteraction);
	value.addEventListener("change", markInteraction);
	let cleanup!: () => void;
	const abort = () => cleanup();
	cleanup = () => {
		sync.signal.removeEventListener("abort", abort);
		value.removeEventListener("input", markInteraction);
		value.removeEventListener("change", markInteraction);
		if (sync.views.get(name) === value) sync.views.delete(name);
		if (sync.viewCleanups.get(name) === cleanup) sync.viewCleanups.delete(name);
		sync.variablesSync?.deleteView(name, value);
	};
	sync.viewCleanups.set(name, cleanup);
	sync.signal.addEventListener("abort", abort, { once: true });
}

/**
 * Replay current model variables into registered `viewof` targets.
 */
export function applyModelVariablesToViews(sync: CellVariableSync): void {
	for (const [name, wireValue] of Object.entries(sync.currentVariables())) {
		const view = sync.views.get(name);
		if (!view) continue;
		if (sameWireValue(toWireValue(readViewValue(view)), wireValue)) continue;
		writeProgrammaticViewValue(view, reviveSyncedValue(wireValue), readModelViewState(sync, name, wireValue));
	}
}

function createBaseSync(
	model: RenderProps<WidgetModel>["model"],
	signal: AbortSignal,
	adapter: {
		readNames(): string[];
		writeNames(names: string[]): void;
		readVars(): Record<string, unknown>;
		writeVars(variables: Record<string, unknown>): void;
		changeEvent: string;
	},
): CellVariableSync {
	const sync: CellVariableSync = {
		model,
		signal,
		views: new Map(),
		viewCleanups: new Map(),
		setVariableNames(names) {
			if (sameWireValue(adapter.readNames(), names)) return;
			adapter.writeNames(names);
		},
		setVariable(name, value) {
			const variables = adapter.readVars();
			if (sameWireValue(variables[name], value)) return;
			recordModelViewState(sync, name, value);
			adapter.writeVars({ ...variables, [name]: value });
		},
		currentVariables: adapter.readVars,
	};
	let writing = false;
	const apply = () => {
		if (!writing) recordExternalModelValues(sync);
		applyModelVariablesToViews(sync);
	};
	const originalSetVariable = sync.setVariable.bind(sync);
	sync.setVariable = (name, value) => {
		const origin = consumeViewInteraction(sync, name) ? "interaction" : "default";
		const before = sync.currentVariables()[name];
		writing = true;
		try {
			originalSetVariable(name, value);
		} finally {
			writing = false;
		}
		if (!sameWireValue(before, sync.currentVariables()[name])) {
			clearExternalModelValue(sync, name);
			recordModelValueOrigin(sync, name, origin);
		}
	};
	model.on(adapter.changeEvent, apply);
	signal.addEventListener("abort", () => model.off(adapter.changeEvent, apply), { once: true });
	return sync;
}

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

export function createRuntimeVariablesSync({
	model,
	runtime,
	options,
	viewNames,
	signal,
	onReset,
	writeViewValue = writeRawViewValue,
}: RuntimeVariablesSyncOptions): RuntimeVariablesSync {
	const views = new Map<string, ViewTarget>();
	const releaseCallbacks = new Map<string, () => void>();
	let variables = { ...options.variables };
	let version = 0;
	let lastPatchSeq = readVariableUpdate(model).seq ?? 0;

	const applyPatch = () => {
		const patch = readVariableUpdate(model);
		const patchSeq = patch.seq ?? 0;
		if (patchSeq <= lastPatchSeq) return;
		lastPatchSeq = patchSeq;
		if (patch.kind === "set") {
			const values = patch.values ?? {};
			variables = { ...variables, ...values };
			options.variables = variables;
			version += 1;
			applyRuntimeVariables(runtime, values, views, viewNames, signal, () => version, writeViewValue);
			return;
		}
		if (patch.kind === "replace") {
			const values = patch.values ?? {};
			for (const [name, release] of releaseCallbacks) {
				if (!Object.prototype.hasOwnProperty.call(values, name)) release();
			}
			variables = { ...values };
			options.variables = variables;
			version += 1;
			onReset(variables);
		}
	};
	model.on("change:_variable_update", applyPatch);
	signal.addEventListener(
		"abort",
		() => {
			model.off("change:_variable_update", applyPatch);
		},
		{ once: true },
	);

	return {
		applyInitialViews() {
			version += 1;
			applyRuntimeVariables(runtime, variables, views, viewNames, signal, () => version, writeViewValue);
		},
		setView(name, view, onVariableRelease) {
			views.set(name, view);
			if (onVariableRelease) releaseCallbacks.set(name, onVariableRelease);
			if (Object.prototype.hasOwnProperty.call(variables, name)) {
				void writeVariableToView(name, view, variables[name], views, signal, () => version, writeViewValue);
			}
		},
		deleteView(name, view) {
			if (views.get(name) === view) {
				views.delete(name);
				releaseCallbacks.delete(name);
			}
		},
	};
}

function readVariableUpdate(model: RenderProps<WidgetModel>["model"]): NonNullable<WidgetModel["_variable_update"]> {
	const value = model.get("_variable_update");
	return value === null || typeof value !== "object" || Array.isArray(value) ? {} : value;
}

function applyRuntimeVariables(
	runtime: NotebookRuntime,
	variables: Record<string, unknown>,
	views: Map<string, ViewTarget>,
	viewNames: Set<string>,
	signal: AbortSignal,
	readVersion: () => number,
	writeViewValue: (view: ViewTarget, value: unknown) => boolean,
): void {
	const definitions: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(variables)) {
		const view = views.get(name);
		if (view) {
			void writeVariableToView(name, view, value, views, signal, readVersion, writeViewValue);
		} else if (viewNames.has(name)) {
			continue;
		} else {
			definitions[name] = value;
		}
	}
	setRuntimeVariables(runtime, definitions);
}

async function writeVariableToView(
	name: string,
	view: ViewTarget,
	wireValue: unknown,
	views: Map<string, ViewTarget>,
	signal: AbortSignal,
	readVersion: () => number,
	writeViewValue: (view: ViewTarget, value: unknown) => boolean,
): Promise<void> {
	const version = readVersion();
	const value = await revivePythonValue(wireValue);
	if (signal.aborted || version !== readVersion() || views.get(name) !== view) return;
	if (sameWireValue(toWireValue(readViewValue(view)), toWireValue(value))) return;
	writeViewValue(view, value);
}

/**
 * Write a view value while suppressing ownership tracking for the dispatched events.
 */
export function writeProgrammaticViewValue(view: ViewTarget, value: unknown, nestedState?: NestedSelectState): boolean {
	programmaticViewWrites.add(view);
	try {
		return writeRawViewValue(view, value, nestedState);
	} finally {
		programmaticViewWrites.delete(view);
	}
}

function isProgrammaticViewWrite(view: ViewTarget): boolean {
	return programmaticViewWrites.has(view);
}

function recordModelViewState(sync: CellVariableSync, name: string, value: unknown): void {
	const view = sync.views.get(name);
	const selects = view ? readNestedSelectState(view) : undefined;
	const states = modelViewStates.get(sync.model) ?? new Map<string, ModelViewState>();
	if (selects && selects.length > 0) {
		states.set(name, { selects, value });
		modelViewStates.set(sync.model, states);
	} else {
		states.delete(name);
	}
}

function recordExternalModelValues(sync: CellVariableSync): void {
	const names = Object.keys(sync.currentVariables());
	if (names.length === 0) return;
	const values = externalModelValues.get(sync.model) ?? new Set<string>();
	for (const name of names) values.add(name);
	externalModelValues.set(sync.model, values);
}

function hasExternalModelValue(sync: CellVariableSync, name: string): boolean {
	return externalModelValues.get(sync.model)?.has(name) === true;
}

function clearExternalModelValue(sync: CellVariableSync, name: string): void {
	const values = externalModelValues.get(sync.model);
	if (!values) return;
	values.delete(name);
	if (values.size === 0) externalModelValues.delete(sync.model);
}

function markViewInteraction(sync: CellVariableSync, name: string): void {
	const values = pendingViewInteractions.get(sync.model) ?? new Set<string>();
	values.add(name);
	pendingViewInteractions.set(sync.model, values);
}

function consumeViewInteraction(sync: CellVariableSync, name: string): boolean {
	const values = pendingViewInteractions.get(sync.model);
	if (!values?.has(name)) return false;
	values.delete(name);
	if (values.size === 0) pendingViewInteractions.delete(sync.model);
	return true;
}

function recordModelValueOrigin(sync: CellVariableSync, name: string, origin: ModelValueOrigin): void {
	const values = modelValueOrigins.get(sync.model) ?? new Map<string, ModelValueOrigin>();
	values.set(name, origin);
	modelValueOrigins.set(sync.model, values);
}

function readModelValueOrigin(sync: CellVariableSync, name: string): ModelValueOrigin | undefined {
	return modelValueOrigins.get(sync.model)?.get(name);
}

function clearModelValueOrigin(sync: CellVariableSync, name: string): void {
	const values = modelValueOrigins.get(sync.model);
	if (!values) return;
	values.delete(name);
	if (values.size === 0) modelValueOrigins.delete(sync.model);
}

function readModelViewState(sync: CellVariableSync, name: string, value: unknown): NestedSelectState | undefined {
	const state = modelViewStates.get(sync.model)?.get(name);
	return state && sameWireValue(state.value, value) ? state.selects : undefined;
}
