import type { NotebookRuntime } from "@observablehq/notebook-kit/runtime";
import { setRuntimeVariables } from "./environment";
import { revivePythonValue, sameWireValue, toWireValue } from "./values";
import {
	readViewValue,
	writeViewValue as writeRawViewValue,
	type RuntimeVariablesSync,
	type ViewTarget,
	type ViewWriteResult,
} from "./views";

export type RuntimeInputs = RuntimeVariablesSync & {
	set(values: Record<string, unknown>): void;
	replace(values: Record<string, unknown>): void;
};

type RuntimeInputsOptions = {
	runtime: NotebookRuntime;
	variables: Record<string, unknown>;
	viewNames: ReadonlySet<string>;
	signal: AbortSignal;
	onVariablesChange?(variables: Record<string, unknown>): void;
	onReplace(variables: Record<string, unknown>): void;
	writeViewValue?(view: ViewTarget, value: unknown): ViewWriteResult;
};

export function createRuntimeInputs({
	runtime,
	variables: initialVariables,
	viewNames,
	signal,
	onVariablesChange,
	onReplace,
	writeViewValue = writeRawViewValue,
}: RuntimeInputsOptions): RuntimeInputs {
	const views = new Map<string, ViewTarget>();
	const releaseCallbacks = new Map<string, () => void>();
	let variables = { ...initialVariables };
	let version = 0;

	return {
		applyInitialViews() {
			version += 1;
			applyRuntimeVariables(runtime, variables, views, viewNames, signal, () => version, writeViewValue);
		},
		set(values) {
			variables = { ...variables, ...values };
			onVariablesChange?.(variables);
			version += 1;
			applyRuntimeVariables(runtime, values, views, viewNames, signal, () => version, writeViewValue);
		},
		replace(values) {
			for (const [name, release] of releaseCallbacks) {
				if (!Object.prototype.hasOwnProperty.call(values, name)) release();
			}
			variables = { ...values };
			onVariablesChange?.(variables);
			version += 1;
			onReplace(variables);
		},
		setView(name, view, onVariableRelease) {
			views.set(name, view);
			if (onVariableRelease) releaseCallbacks.set(name, onVariableRelease);
			if (Object.prototype.hasOwnProperty.call(variables, name)) {
				void writeVariableToView(runtime, name, view, variables[name], views, signal, () => version, writeViewValue);
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

function applyRuntimeVariables(
	runtime: NotebookRuntime,
	variables: Record<string, unknown>,
	views: Map<string, ViewTarget>,
	viewNames: ReadonlySet<string>,
	signal: AbortSignal,
	readVersion: () => number,
	writeViewValue: (view: ViewTarget, value: unknown) => ViewWriteResult,
): void {
	const definitions: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(variables)) {
		const view = views.get(name);
		if (view) {
			void writeVariableToView(runtime, name, view, value, views, signal, readVersion, writeViewValue);
		} else if (!viewNames.has(name)) {
			definitions[name] = value;
		}
	}
	setRuntimeVariables(runtime, definitions);
}

async function writeVariableToView(
	runtime: NotebookRuntime,
	name: string,
	view: ViewTarget,
	wireValue: unknown,
	views: Map<string, ViewTarget>,
	signal: AbortSignal,
	readVersion: () => number,
	writeViewValue: (view: ViewTarget, value: unknown) => ViewWriteResult,
): Promise<void> {
	const version = readVersion();
	const value = await revivePythonValue(wireValue);
	if (signal.aborted || version !== readVersion() || views.get(name) !== view) return;
	if (sameWireValue(toWireValue(readViewValue(view)), toWireValue(value))) return;
	const result = writeViewValue(view, value);
	if (result === "unsupported" && !signal.aborted && version === readVersion() && views.get(name) === view) {
		setRuntimeVariables(runtime, { [name]: wireValue });
	}
}
