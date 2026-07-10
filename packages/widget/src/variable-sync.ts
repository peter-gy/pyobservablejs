import type { RenderProps } from "@anywidget/types";
import type { NotebookRuntime } from "@observablehq/notebook-kit/runtime";
import {
	createRuntimeInputs,
	isViewTarget,
	isWritableSyncedViewValue,
	readNestedSelectState,
	readViewValue,
	reviveSyncedValue,
	runtimeCompatibilityBuiltinNames,
	sameWireValue,
	toWireValue,
	writeViewValue as writeRawViewValue,
	type NestedSelectState,
	type NotebookOptions,
	type RuntimeVariablesSync,
	type ViewWriteResult,
	type ViewTarget,
} from "@pyobservablejs/runtime";
import { readModelVariables, type WidgetModel } from "./model";

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
	writeViewValue?(view: ViewTarget, value: unknown): ViewWriteResult;
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
		if (!isWritableSyncedViewValue(wireValue)) continue;
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
		if (writing) return;
		recordExternalModelValues(sync);
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

export function createRuntimeVariablesSync({
	model,
	runtime,
	options,
	viewNames,
	signal,
	onReset,
	writeViewValue = writeRawViewValue,
}: RuntimeVariablesSyncOptions): RuntimeVariablesSync {
	let lastPatchSeq = readVariableUpdate(model).seq ?? 0;
	const inputs = createRuntimeInputs({
		runtime,
		variables: options.variables,
		viewNames,
		signal,
		onVariablesChange(variables) {
			options.variables = variables;
		},
		onReplace: onReset,
		writeViewValue,
	});

	const applyPatch = () => {
		const patch = readVariableUpdate(model);
		const patchSeq = patch.seq ?? 0;
		if (patchSeq <= lastPatchSeq) return;
		lastPatchSeq = patchSeq;
		if (patch.kind === "set") {
			const values = patch.values ?? {};
			assertNoRuntimeCompatibilityCollisions(values, options.runtimeCompatibility);
			inputs.set(values);
			return;
		}
		if (patch.kind === "replace") {
			const values = patch.values ?? {};
			assertNoRuntimeCompatibilityCollisions(values, options.runtimeCompatibility);
			inputs.replace(values);
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

	return inputs;
}

function assertNoRuntimeCompatibilityCollisions(
	variables: Record<string, unknown>,
	compatibility: NotebookOptions["runtimeCompatibility"],
): void {
	const collisions = runtimeCompatibilityBuiltinNames(compatibility).filter((name) =>
		Object.prototype.hasOwnProperty.call(variables, name),
	);
	if (collisions.length > 0) {
		throw new Error(`Python variables cannot override Observable runtime builtins: ${collisions.sort().join(", ")}`);
	}
}

function readVariableUpdate(model: RenderProps<WidgetModel>["model"]): NonNullable<WidgetModel["_variable_update"]> {
	const value = model.get("_variable_update");
	return value === null || typeof value !== "object" || Array.isArray(value) ? {} : value;
}

/**
 * Write a view value while suppressing ownership tracking for the dispatched events.
 */
export function writeProgrammaticViewValue(
	view: ViewTarget,
	value: unknown,
	nestedState?: NestedSelectState,
): ViewWriteResult {
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
