import type { NotebookRuntime } from "@observablehq/notebook-kit/runtime";
import {
	assertNoRuntimeBuiltinCollisions,
	createRuntimeInputs,
	isViewTarget,
	isWritableSyncedViewValue,
	readViewValue,
	reviveSyncedValue,
	sameWireValue,
	toWireValue,
	writeViewValue as writeRawViewValue,
	type NotebookOptions,
	type RuntimeVariablesSync,
	type ViewTarget,
	type ViewWriteResult,
} from "@pyobservablejs/runtime";
import { isRecord, type AnyWidgetModel, type WidgetModel } from "./model";
import type { CellReadback } from "./readback";

type RuntimeVariablesSyncOptions = {
	model: AnyWidgetModel;
	runtime: NotebookRuntime;
	options: NotebookOptions;
	viewNames: Set<string>;
	signal: AbortSignal;
	onReset(variables: Record<string, unknown>): void;
	writeViewValue?(view: ViewTarget, value: unknown): ViewWriteResult;
};

export type RuntimeVariablesController = RuntimeVariablesSync & {
	subscribe(callback: (clearedViewNames: ReadonlySet<string>) => void): () => void;
};

export type RuntimeViewSync = {
	register(name: string, value: unknown): void;
};

export type CellVariableSync = {
	setVariableNames(names: string[]): void;
	setVariable(name: string, value: unknown): void;
	markRendered(): void;
};

const programmaticViewWrites = new WeakSet<ViewTarget>();

/** Buffer one selected cell until all exposed values settle. */
export function createCellStateSync({
	read,
	publish,
}: {
	read(): CellReadback;
	publish(value: CellReadback): void;
}): CellVariableSync {
	const initial = read();
	let names = [...initial.names];
	let variables = { ...initial.values };
	let rendered = false;
	const publishCurrent = () => publish({ rendered: true, names: [...names], values: { ...variables } });
	return {
		setVariableNames(nextNames) {
			if (sameWireValue(names, nextNames)) return;
			names = [...nextNames];
			if (rendered) publishCurrent();
		},
		setVariable(name, value) {
			if (sameWireValue(variables[name], value)) return;
			variables = { ...variables, [name]: value };
			if (rendered) publishCurrent();
		},
		markRendered() {
			if (rendered) return;
			rendered = true;
			publishCurrent();
		},
	};
}

/**
 * Coordinate every `viewof` target in this runtime with session-owned state.
 * Browser interactions publish to the session. Session and Python writes use
 * programmatic events so they update Observable without becoming interactions.
 */
export function createRuntimeViewSync({
	model,
	variables,
	signal,
}: {
	model: AnyWidgetModel;
	variables: RuntimeVariablesController;
	signal: AbortSignal;
}): RuntimeViewSync {
	const views = new Map<string, ViewTarget>();
	const cleanups = new Map<string, () => void>();
	let sharedValues = readViewValues(model);

	const publish = (name: string, value: unknown) => {
		if (sameWireValue(sharedValues[name], value) && Object.prototype.hasOwnProperty.call(sharedValues, name)) return;
		sharedValues = { ...sharedValues, [name]: value };
		model.set("_view_values", sharedValues);
		model.save_changes();
	};
	const clear = (names: ReadonlySet<string>) => {
		const next = { ...sharedValues };
		let changed = false;
		for (const name of names) {
			if (!Object.prototype.hasOwnProperty.call(next, name)) continue;
			delete next[name];
			changed = true;
		}
		if (!changed) return;
		sharedValues = next;
		model.set("_view_values", sharedValues);
		model.save_changes();
	};

	const apply = () => {
		sharedValues = readViewValues(model);
		for (const [name, wireValue] of Object.entries(sharedValues)) {
			const view = views.get(name);
			if (!view || !isWritableSyncedViewValue(wireValue)) continue;
			if (sameWireValue(toWireValue(readViewValue(view)), wireValue)) continue;
			writeProgrammaticViewValue(view, reviveSyncedValue(wireValue));
		}
	};

	const unsubscribeVariables = variables.subscribe(clear);
	model.on("change:_view_values", apply);
	signal.addEventListener(
		"abort",
		() => {
			model.off("change:_view_values", apply);
			unsubscribeVariables();
			for (const cleanup of cleanups.values()) cleanup();
		},
		{ once: true },
	);

	return {
		register(name, value) {
			if (!isViewTarget(value)) return;
			if (views.get(name) === value) {
				variables.setView(name, value, { applyInitialVariable: !hasSharedViewValue(sharedValues, name) });
				return;
			}
			cleanups.get(name)?.();
			views.set(name, value);
			const onInteraction = () => {
				if (isProgrammaticViewWrite(value)) return;
				const wireValue = toWireValue(readViewValue(value));
				if (isWritableSyncedViewValue(wireValue)) publish(name, wireValue);
			};
			value.addEventListener("input", onInteraction);
			value.addEventListener("change", onInteraction);
			const cleanup = () => {
				value.removeEventListener("input", onInteraction);
				value.removeEventListener("change", onInteraction);
				if (views.get(name) === value) views.delete(name);
				if (cleanups.get(name) === cleanup) cleanups.delete(name);
				variables.deleteView(name, value);
			};
			cleanups.set(name, cleanup);

			const hasSharedValue = hasSharedViewValue(sharedValues, name);
			if (hasSharedValue) {
				writeProgrammaticViewValue(value, reviveSyncedValue(sharedValues[name]));
			}
			variables.setView(name, value, { applyInitialVariable: !hasSharedValue });
		},
	};
}

export function createRuntimeVariablesSync({
	model,
	runtime,
	options,
	viewNames,
	signal,
	onReset,
	writeViewValue = writeRawViewValue,
}: RuntimeVariablesSyncOptions): RuntimeVariablesController {
	let lastPatchSeq = readVariableUpdate(model).seq ?? 0;
	const listeners = new Set<(clearedViewNames: ReadonlySet<string>) => void>();
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
			assertNoRuntimeBuiltinCollisions(runtime, values);
			notifyViewStateClears(listeners, Object.keys(values));
			inputs.set(values);
			return;
		}
		if (patch.kind === "replace") {
			const values = patch.values ?? {};
			assertNoRuntimeBuiltinCollisions(runtime, values);
			notifyViewStateClears(listeners, [...Object.keys(options.variables), ...Object.keys(values)]);
			inputs.replace(values);
		}
	};
	model.on("change:_variable_update", applyPatch);
	signal.addEventListener("abort", () => model.off("change:_variable_update", applyPatch), { once: true });

	return {
		...inputs,
		subscribe(callback) {
			listeners.add(callback);
			return () => listeners.delete(callback);
		},
	};
}

function notifyViewStateClears(
	listeners: ReadonlySet<(clearedViewNames: ReadonlySet<string>) => void>,
	names: readonly string[],
): void {
	const clearedNames = new Set(names);
	if (clearedNames.size === 0) return;
	for (const listener of listeners) listener(clearedNames);
}

function hasSharedViewValue(values: Record<string, unknown>, name: string): boolean {
	return Object.prototype.hasOwnProperty.call(values, name) && isWritableSyncedViewValue(values[name]);
}

function readVariableUpdate(model: AnyWidgetModel): NonNullable<WidgetModel["_variable_update"]> {
	const value = model.get("_variable_update");
	return isRecord(value) ? (value as NonNullable<WidgetModel["_variable_update"]>) : {};
}

function readViewValues(model: AnyWidgetModel): Record<string, unknown> {
	const value = model.get("_view_values");
	return isRecord(value) ? value : {};
}

/** Dispatch Observable input events without publishing them as interactions. */
export function writeProgrammaticViewValue(view: ViewTarget, value: unknown): ViewWriteResult {
	programmaticViewWrites.add(view);
	try {
		return writeRawViewValue(view, value);
	} finally {
		programmaticViewWrites.delete(view);
	}
}

function isProgrammaticViewWrite(view: ViewTarget): boolean {
	return programmaticViewWrites.has(view);
}
