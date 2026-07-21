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
import {
	structuredCellError,
	type CellErrorWire,
	type CellReadback,
	type ErrorPhase,
	type ReadbackToken,
} from "./readback";

type RuntimeVariablesSyncOptions = {
	model: AnyWidgetModel;
	runtime: NotebookRuntime;
	options: NotebookOptions;
	viewNames: Set<string>;
	signal: AbortSignal;
	onReset(variables: Record<string, unknown>): void;
	onInput?(names: ReadonlySet<string>): void;
	writeViewValue?(view: ViewTarget, value: unknown): ViewWriteResult;
};

export type RuntimeVariablesController = RuntimeVariablesSync & {
	subscribe(callback: (clearedViewNames: ReadonlySet<string>) => void): () => void;
};

export type RuntimeViewSync = {
	register(name: string, value: unknown): void;
};

export type CellVariableSync = {
	configure(names: string[], display: boolean): void;
	pending(channel: string): void;
	fulfilled(channel: string, name?: string, value?: unknown): void;
	rejected(channel: string, error: unknown, phase: ErrorPhase, variable?: string): void;
	fail(error: unknown, phase: ErrorPhase, variable?: string): void;
};

const programmaticViewWrites = new WeakSet<ViewTarget>();

/** Aggregate every observer channel into one selected-cell result. */
export function createCellStateSync({
	begin,
	settle,
}: {
	begin(channel: string, generation: number): ReadbackToken | null;
	settle(token: ReadbackToken, value: Omit<CellReadback, "revision">): void;
}): CellVariableSync {
	const expected = new Set<string>();
	const statuses = new Map<string, "pending" | "success" | "error">();
	const generations = new Map<string, number>();
	const tokens = new Map<string, ReadbackToken>();
	const values = new Map<string, { name: string; value: unknown }>();
	const errors = new Map<string, CellErrorWire>();
	let revision = -1;

	const start = (channel: string): ReadbackToken | null => {
		const generation = (generations.get(channel) ?? 0) + 1;
		generations.set(channel, generation);
		const token = begin(channel, generation);
		if (!token) return null;
		if (token.revision > revision) {
			revision = token.revision;
			for (const expectedChannel of expected) {
				if (statuses.get(expectedChannel) === "pending") tokens.delete(expectedChannel);
			}
		}
		tokens.set(channel, token);
		statuses.set(channel, "pending");
		values.delete(channel);
		errors.delete(channel);
		return token;
	};

	const tokenFor = (channel: string) =>
		statuses.get(channel) === "pending" ? (tokens.get(channel) ?? start(channel)) : start(channel);
	const settleIfReady = (token: ReadbackToken) => {
		if ([...expected].some((channel) => statuses.get(channel) === "pending")) return;
		const resultErrors = [...errors.values()];
		settle(token, {
			status: resultErrors.length > 0 ? "error" : "success",
			values: Object.fromEntries([...values.values()].map((item) => [item.name, item.value])),
			errors: resultErrors,
		});
	};

	return {
		configure(names, display) {
			expected.clear();
			if (display) expected.add("display");
			for (const name of names) expected.add(`variable:${name}`);
			for (const channel of expected) {
				if (!statuses.has(channel)) statuses.set(channel, "pending");
			}
		},
		pending(channel) {
			start(channel);
		},
		fulfilled(channel, name, value) {
			const token = tokenFor(channel);
			if (!token || tokens.get(channel) !== token) return;
			statuses.set(channel, "success");
			if (name !== undefined) values.set(channel, { name, value });
			errors.delete(channel);
			settleIfReady(token);
		},
		rejected(channel, error, phase, variable) {
			const token = tokenFor(channel);
			if (!token || tokens.get(channel) !== token) return;
			statuses.set(channel, "error");
			values.delete(channel);
			errors.set(channel, structuredCellError(error, phase, variable));
			settleIfReady(token);
		},
		fail(error, phase, variable) {
			const channel = "failure";
			expected.clear();
			expected.add(channel);
			const token = start(channel);
			if (!token) return;
			statuses.set(channel, "error");
			errors.set(channel, structuredCellError(error, phase, variable));
			settleIfReady(token);
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
	onInput = () => {},
}: {
	model: AnyWidgetModel;
	variables: RuntimeVariablesController;
	signal: AbortSignal;
	onInput?(names: ReadonlySet<string>): void;
}): RuntimeViewSync {
	const views = new Map<string, ViewTarget>();
	const cleanups = new Map<string, () => void>();
	let sharedValues = readViewValues(model);

	const publish = (name: string, value: unknown) => {
		if (sameWireValue(sharedValues[name], value) && Object.prototype.hasOwnProperty.call(sharedValues, name)) return;
		onInput(new Set([name]));
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
		const previous = sharedValues;
		sharedValues = readViewValues(model);
		const changed = new Set(
			Object.entries(sharedValues)
				.filter(([name, value]) => !sameWireValue(previous[name], value))
				.map(([name]) => name),
		);
		if (changed.size > 0) onInput(changed);
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
			value.addEventListener("input", onInteraction, { capture: true });
			value.addEventListener("change", onInteraction, { capture: true });
			const cleanup = () => {
				value.removeEventListener("input", onInteraction, { capture: true });
				value.removeEventListener("change", onInteraction, { capture: true });
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
	onInput = () => {},
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
			onInput(new Set(Object.keys(values)));
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
