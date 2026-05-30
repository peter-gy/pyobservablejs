import type { RenderProps } from "@anywidget/types";
import { readModelVariables } from "../model/values";
import type { WidgetModel } from "../model/types";
import type { RuntimeVariablesSync } from "../runtime/types";
import { isViewTarget, readViewValue } from "../runtime/view";
import { reviveSyncedValue, sameWireValue, toWireValue } from "../runtime/wire";
import type { CellVariableSync } from "./types";
import {
	clearExternalModelValue,
	clearModelValueOrigin,
	consumeViewInteraction,
	hasExternalModelValue,
	isProgrammaticViewWrite,
	markViewInteraction,
	readModelValueOrigin,
	readModelViewState,
	recordExternalModelValues,
	recordModelValueOrigin,
	recordModelViewState,
	writeProgrammaticViewValue,
} from "./view-state";

export { writeProgrammaticViewValue } from "./view-state";

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
