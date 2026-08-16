import type { NotebookRuntime } from "@observablehq/notebook-kit/runtime";
import { setRuntimeVariables } from "./environment";
import {
	revivePythonValue,
	sameWireValue,
	toWireValue,
	type RevivedValue,
	type WireValue,
	type WireValues,
} from "./values";
import {
	readViewValue,
	writeViewValue as writeRawViewValue,
	type RuntimeVariablesSync,
	type ViewTarget,
	type ViewWriteResult,
} from "./views";

export type RuntimeInputs = RuntimeVariablesSync & {
	set(values: WireValues): void;
	replace(values: WireValues): void;
};

type RuntimeInputsOptions = {
	runtime: NotebookRuntime;
	variables: WireValues;
	viewNames: ReadonlySet<string>;
	signal: AbortSignal;
	onVariablesChange?(variables: WireValues): void;
	onReplace(variables: WireValues): void;
	writeViewValue?(view: ViewTarget, value: RevivedValue): ViewWriteResult;
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
	const suppressedInitialViews = new Map<string, ViewTarget>();
	let variables = { ...initialVariables };
	let version = 0;

	return {
		applyInitialViews() {
			version += 1;
			const initialVariables = Object.fromEntries(
				Object.entries(variables).filter(([name]) => suppressedInitialViews.get(name) !== views.get(name)),
			);
			suppressedInitialViews.clear();
			applyRuntimeVariables(runtime, initialVariables, views, viewNames, signal, () => version, writeViewValue);
		},
		set(values) {
			variables = { ...variables, ...values };
			onVariablesChange?.(variables);
			version += 1;
			applyRuntimeVariables(runtime, values, views, viewNames, signal, () => version, writeViewValue);
		},
		replace(values) {
			variables = { ...values };
			onVariablesChange?.(variables);
			version += 1;
			onReplace(variables);
		},
		setView(name, view, options) {
			views.set(name, view);
			if (options?.applyInitialVariable === false) suppressedInitialViews.set(name, view);
			else suppressedInitialViews.delete(name);
			if (options?.applyInitialVariable !== false && Object.prototype.hasOwnProperty.call(variables, name)) {
				void writeVariableToView(runtime, name, view, variables[name], views, signal, () => version, writeViewValue);
			}
		},
		deleteView(name, view) {
			if (views.get(name) === view) {
				views.delete(name);
				suppressedInitialViews.delete(name);
			}
		},
	};
}

function applyRuntimeVariables(
	runtime: NotebookRuntime,
	variables: WireValues,
	views: Map<string, ViewTarget>,
	viewNames: ReadonlySet<string>,
	signal: AbortSignal,
	readVersion: () => number,
	writeViewValue: (view: ViewTarget, value: RevivedValue) => ViewWriteResult,
): void {
	const definitions: WireValues = {};
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
	wireValue: WireValue,
	views: Map<string, ViewTarget>,
	signal: AbortSignal,
	readVersion: () => number,
	writeViewValue: (view: ViewTarget, value: RevivedValue) => ViewWriteResult,
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
