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
import type { WidgetModel } from "./model";
import type { CellReadback } from "./readback";

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
	signal: AbortSignal;
	variablesSync?: RuntimeVariablesSync;
	views: Map<string, ViewTarget>;
	viewCleanups: Map<string, () => void>;
	setVariableNames(names: string[]): void;
	setVariable(name: string, value: unknown): void;
	markRendered(): void;
	currentVariables(): Record<string, unknown>;
};

const modelViewStates = new WeakMap<CellVariableSync, Map<string, ModelViewState>>();
const externalModelValues = new WeakMap<CellVariableSync, Set<string>>();
const modelValueOrigins = new WeakMap<CellVariableSync, Map<string, ModelValueOrigin>>();
const pendingViewInteractions = new WeakMap<CellVariableSync, Set<string>>();
const programmaticViewWrites = new WeakSet<ViewTarget>();

/**
 * Buffer a render attempt until the cell settles, then publish its complete
 * readback through the parent Notebook model. Successful snapshots from other
 * views seed replacement controls and remain visible while this attempt runs.
 */
export function createCellStateSync({
	model,
	signal,
	variablesSync,
	read,
	publish,
}: {
	model: RenderProps<WidgetModel>["model"];
	signal: AbortSignal;
	variablesSync?: RuntimeVariablesSync;
	read(): CellReadback;
	publish(value: CellReadback): void;
}): CellVariableSync {
	const initial = read();
	let names = [...initial.names];
	let variables = { ...initial.values };
	let rendered = false;
	let writing = false;
	const publishCurrent = () => publish({ rendered: true, names: [...names], values: { ...variables } });
	const sync: CellVariableSync = {
		signal,
		variablesSync,
		views: new Map(),
		viewCleanups: new Map(),
		setVariableNames(nextNames) {
			if (sameWireValue(names, nextNames)) return;
			names = [...nextNames];
			if (rendered) publishCurrent();
		},
		setVariable(name, value) {
			if (sameWireValue(variables[name], value)) return;
			const origin = consumeViewInteraction(sync, name) ? "interaction" : "default";
			const before = variables[name];
			writing = true;
			try {
				recordModelViewState(sync, name, value);
				variables = { ...variables, [name]: value };
				if (rendered) publishCurrent();
			} finally {
				writing = false;
			}
			if (!sameWireValue(before, variables[name])) {
				clearExternalModelValue(sync, name);
				recordModelValueOrigin(sync, name, origin);
			}
		},
		markRendered() {
			if (rendered) return;
			rendered = true;
			writing = true;
			try {
				publishCurrent();
			} finally {
				writing = false;
			}
		},
		currentVariables() {
			return variables;
		},
	};
	const apply = () => {
		if (writing) return;
		const external = read();
		if (!external.rendered) return;
		if (sameWireValue(external.names, names) && sameWireValue(external.values, variables)) return;
		names = [...external.names];
		variables = { ...external.values };
		recordExternalModelValues(sync);
		applyModelVariablesToViews(sync);
	};
	model.on("change:_cell_values", apply);
	signal.addEventListener("abort", () => model.off("change:_cell_values", apply), { once: true });
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
	const states = modelViewStates.get(sync) ?? new Map<string, ModelViewState>();
	if (selects && selects.length > 0) {
		states.set(name, { selects, value });
		modelViewStates.set(sync, states);
	} else {
		states.delete(name);
	}
}

function recordExternalModelValues(sync: CellVariableSync): void {
	const names = Object.keys(sync.currentVariables());
	if (names.length === 0) return;
	const values = externalModelValues.get(sync) ?? new Set<string>();
	for (const name of names) values.add(name);
	externalModelValues.set(sync, values);
}

function hasExternalModelValue(sync: CellVariableSync, name: string): boolean {
	return externalModelValues.get(sync)?.has(name) === true;
}

function clearExternalModelValue(sync: CellVariableSync, name: string): void {
	const values = externalModelValues.get(sync);
	if (!values) return;
	values.delete(name);
	if (values.size === 0) externalModelValues.delete(sync);
}

function markViewInteraction(sync: CellVariableSync, name: string): void {
	const values = pendingViewInteractions.get(sync) ?? new Set<string>();
	values.add(name);
	pendingViewInteractions.set(sync, values);
}

function consumeViewInteraction(sync: CellVariableSync, name: string): boolean {
	const values = pendingViewInteractions.get(sync);
	if (!values?.has(name)) return false;
	values.delete(name);
	if (values.size === 0) pendingViewInteractions.delete(sync);
	return true;
}

function recordModelValueOrigin(sync: CellVariableSync, name: string, origin: ModelValueOrigin): void {
	const values = modelValueOrigins.get(sync) ?? new Map<string, ModelValueOrigin>();
	values.set(name, origin);
	modelValueOrigins.set(sync, values);
}

function readModelValueOrigin(sync: CellVariableSync, name: string): ModelValueOrigin | undefined {
	return modelValueOrigins.get(sync)?.get(name);
}

function clearModelValueOrigin(sync: CellVariableSync, name: string): void {
	const values = modelValueOrigins.get(sync);
	if (!values) return;
	values.delete(name);
	if (values.size === 0) modelValueOrigins.delete(sync);
}

function readModelViewState(sync: CellVariableSync, name: string, value: unknown): NestedSelectState | undefined {
	const state = modelViewStates.get(sync)?.get(name);
	return state && sameWireValue(state.value, value) ? state.selects : undefined;
}
