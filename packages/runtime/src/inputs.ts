import { library, type NotebookRuntime } from "@observablehq/notebook-kit/runtime";
import { setRuntimeVariables } from "./environment";
import type { RuntimeValue, Variables } from "./values";
import {
	writeViewValue as writeRawViewValue,
	type RuntimeVariablesSync,
	type ViewTarget,
	type ViewWriteResult,
} from "./views";

export type RuntimeInputs = RuntimeVariablesSync & {
	set(values: Variables): void;
	replace(values: Variables): void;
};

type RuntimeInputsOptions = {
	runtime: NotebookRuntime;
	variables: Variables;
	viewNames: ReadonlySet<string>;
	signal: AbortSignal;
	onVariablesChange?(variables: Variables): void;
	onReplace(variables: Variables): void;
	onError<Cause>(name: string, cause: Cause): void;
	writeViewValue?(view: ViewTarget, value: RuntimeValue): ViewWriteResult;
};

export function createRuntimeInputs({
	runtime,
	variables: initialVariables,
	viewNames,
	signal,
	onVariablesChange,
	onReplace,
	onError,
	writeViewValue = writeRawViewValue,
}: RuntimeInputsOptions): RuntimeInputs {
	const views = new Map<string, ViewTarget>();
	const suppressedInitialViews = new Map<string, ViewTarget>();
	let variables = { ...initialVariables };
	const versions = new Map<string, number>();
	const overriddenViews = new Set<string>();

	const apply = (values: Variables) => {
		const definitions: [string, RuntimeValue][] = [];
		for (const [name, value] of Object.entries(values)) {
			const view = views.get(name);
			if (view) void write(name, view, value);
			else if (!viewNames.has(name)) definitions.push([name, value]);
		}
		setRuntimeVariables(runtime, Object.fromEntries(definitions));
	};

	const write = async (name: string, view: ViewTarget, inputValue: RuntimeValue) => {
		const version = (versions.get(name) ?? 0) + 1;
		versions.set(name, version);
		const current = () => !signal.aborted && version === versions.get(name) && views.get(name) === view;
		try {
			let value: RuntimeValue;
			try {
				value = await Promise.resolve(inputValue);
			} catch {
				if (!current()) return;
				setRuntimeVariables(runtime, { [name]: inputValue });
				overriddenViews.add(name);
				return;
			}
			if (!current()) return;
			// Input revisions need an Observable event to settle, including
			// writes that adopt the control's current value.
			const result = writeViewValue(view, value);
			if (!current()) return;
			if (result === "unsupported") {
				setRuntimeVariables(runtime, { [name]: inputValue });
				overriddenViews.add(name);
			} else if (overriddenViews.delete(name)) {
				// A constant override disconnects Notebook Kit's generated input variable.
				// Restore that dependency when the control can represent the host value.
				runtime.main.redefine(name, [`viewof$${name}`], library.Generators().input);
			}
		} catch (cause) {
			if (current()) onError(name, cause);
		}
	};

	return {
		applyInitialViews() {
			const initialVariables = Object.fromEntries(
				Object.entries(variables).filter(([name]) => suppressedInitialViews.get(name) !== views.get(name)),
			);
			suppressedInitialViews.clear();
			apply(initialVariables);
		},
		set(values) {
			variables = { ...variables, ...values };
			onVariablesChange?.(variables);
			apply(values);
		},
		replace(values) {
			variables = { ...values };
			onVariablesChange?.(variables);
			for (const [name, version] of versions) versions.set(name, version + 1);
			onReplace(variables);
		},
		setView(name, view, options) {
			views.set(name, view);
			if (options?.applyInitialVariable === false) suppressedInitialViews.set(name, view);
			else suppressedInitialViews.delete(name);
			if (options?.applyInitialVariable !== false && Object.prototype.hasOwnProperty.call(variables, name)) {
				void write(name, view, variables[name]);
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
