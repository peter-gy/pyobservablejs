import type { RenderProps } from "@anywidget/types";
import type { NotebookRuntime } from "@observablehq/notebook-kit/runtime";
import { setRuntimeVariables } from "./runtime";
import type { NotebookOptions, RuntimeVariablesSync, ViewTarget, WidgetModel } from "./types";
import { readViewValue, writeViewValue } from "./view";
import { revivePythonValue, sameWireValue, toWireValue } from "./wire";

type RuntimeVariablesSyncOptions = {
	model: RenderProps<WidgetModel>["model"];
	runtime: NotebookRuntime;
	options: NotebookOptions;
	viewNames: Set<string>;
	signal: AbortSignal;
	onReset(): void;
};

export function createRuntimeVariablesSync({
	model,
	runtime,
	options,
	viewNames,
	signal,
	onReset,
}: RuntimeVariablesSyncOptions): RuntimeVariablesSync {
	const views = new Map<string, ViewTarget>();
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
			applyRuntimeVariables(runtime, values, views, viewNames, signal, () => version);
			return;
		}
		if (patch.kind === "replace") {
			onReset();
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
			applyRuntimeVariables(runtime, variables, views, viewNames, signal, () => version);
		},
		setView(name, view) {
			views.set(name, view);
			if (Object.prototype.hasOwnProperty.call(variables, name)) {
				void writeVariableToView(name, view, variables[name], views, signal, () => version);
			}
		},
		deleteView(name, view) {
			if (views.get(name) === view) views.delete(name);
		},
	};
}

export function readNotebookVariables(model: RenderProps<WidgetModel>["model"]): Record<string, unknown> {
	const value = model.get("_variables");
	return value === null || typeof value !== "object" || Array.isArray(value) ? {} : value;
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
): void {
	const definitions: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(variables)) {
		const view = views.get(name);
		if (view) {
			void writeVariableToView(name, view, value, views, signal, readVersion);
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
): Promise<void> {
	const version = readVersion();
	const value = await revivePythonValue(wireValue);
	if (signal.aborted || version !== readVersion() || views.get(name) !== view) return;
	if (sameWireValue(toWireValue(readViewValue(view)), toWireValue(value))) return;
	writeViewValue(view, value);
}
