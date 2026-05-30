import type { RenderProps } from "@anywidget/types";
import type { WidgetModel } from "../model/types";
import type { ViewTarget } from "../runtime/types";
import { readNestedSelectState, type NestedSelectState, writeViewValue } from "../runtime/view";
import { sameWireValue } from "../runtime/wire";
import type { CellVariableSync } from "./types";

type ModelViewState = {
	selects: NestedSelectState;
	value: unknown;
};

type ModelValueOrigin = "default" | "interaction";

const modelViewStates = new WeakMap<RenderProps<WidgetModel>["model"], Map<string, ModelViewState>>();
const externalModelValues = new WeakMap<RenderProps<WidgetModel>["model"], Set<string>>();
const modelValueOrigins = new WeakMap<RenderProps<WidgetModel>["model"], Map<string, ModelValueOrigin>>();
const pendingViewInteractions = new WeakMap<RenderProps<WidgetModel>["model"], Set<string>>();
const programmaticViewWrites = new WeakSet<ViewTarget>();

/**
 * Write a view value while suppressing ownership tracking for the dispatched events.
 */
export function writeProgrammaticViewValue(view: ViewTarget, value: unknown, nestedState?: NestedSelectState): boolean {
	programmaticViewWrites.add(view);
	try {
		return writeViewValue(view, value, nestedState);
	} finally {
		programmaticViewWrites.delete(view);
	}
}

export function isProgrammaticViewWrite(view: ViewTarget): boolean {
	return programmaticViewWrites.has(view);
}

export function recordModelViewState(sync: CellVariableSync, name: string, value: unknown): void {
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

export function recordExternalModelValues(sync: CellVariableSync): void {
	const names = Object.keys(sync.currentVariables());
	if (names.length === 0) return;
	const values = externalModelValues.get(sync.model) ?? new Set<string>();
	for (const name of names) values.add(name);
	externalModelValues.set(sync.model, values);
}

export function hasExternalModelValue(sync: CellVariableSync, name: string): boolean {
	return externalModelValues.get(sync.model)?.has(name) === true;
}

export function clearExternalModelValue(sync: CellVariableSync, name: string): void {
	const values = externalModelValues.get(sync.model);
	if (!values) return;
	values.delete(name);
	if (values.size === 0) externalModelValues.delete(sync.model);
}

export function markViewInteraction(sync: CellVariableSync, name: string): void {
	const values = pendingViewInteractions.get(sync.model) ?? new Set<string>();
	values.add(name);
	pendingViewInteractions.set(sync.model, values);
}

export function consumeViewInteraction(sync: CellVariableSync, name: string): boolean {
	const values = pendingViewInteractions.get(sync.model);
	if (!values?.has(name)) return false;
	values.delete(name);
	if (values.size === 0) pendingViewInteractions.delete(sync.model);
	return true;
}

export function recordModelValueOrigin(sync: CellVariableSync, name: string, origin: ModelValueOrigin): void {
	const values = modelValueOrigins.get(sync.model) ?? new Map<string, ModelValueOrigin>();
	values.set(name, origin);
	modelValueOrigins.set(sync.model, values);
}

export function readModelValueOrigin(sync: CellVariableSync, name: string): ModelValueOrigin | undefined {
	return modelValueOrigins.get(sync.model)?.get(name);
}

export function clearModelValueOrigin(sync: CellVariableSync, name: string): void {
	const values = modelValueOrigins.get(sync.model);
	if (!values) return;
	values.delete(name);
	if (values.size === 0) modelValueOrigins.delete(sync.model);
}

export function readModelViewState(
	sync: CellVariableSync,
	name: string,
	value: unknown,
): NestedSelectState | undefined {
	const state = modelViewStates.get(sync.model)?.get(name);
	return state && sameWireValue(state.value, value) ? state.selects : undefined;
}
