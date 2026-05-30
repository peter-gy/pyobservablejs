import { transpile } from "@observablehq/notebook-kit";
import { observe, type DefineState, type NotebookRuntime } from "@observablehq/notebook-kit/runtime";
import { readModelVariables } from "../model/values";
import { createRuntimeDefinition, runtimeVariableNames } from "../runtime/definition";
import {
	defineMissingRuntimeVariables,
	isUndefinedRuntimeVariable,
	type RuntimeModule,
} from "../runtime/module-imports";
import { reviveSyncedValue } from "../runtime/wire";
import {
	canReviveDependencyValue,
	dependencyCellIndexes,
	isSourceResolvableDependencyCell,
	liveDependencyModel,
	notebookDefinesName,
	transpileDependencyCell,
} from "./standalone-resolution";
import type { CellRenderContext } from "./types";

type TranspiledDefinition = ReturnType<typeof transpile>;

export function defineStandaloneDependencyCells(
	runtime: NotebookRuntime,
	context: CellRenderContext,
	targetDefinition: TranspiledDefinition,
	signal: AbortSignal,
): void {
	const states: DefineState[] = [];
	const listenerCleanups: Array<() => void> = [];
	const definitions = new Map<number, TranspiledDefinition>();
	const defining = new Set<number>();
	const defined = new Set<number>();
	const liveWatched = new Set<string>();
	const liveDefined = new Set<string>();
	const sourceDefined = new Set<string>();
	const cleanup = () => {
		for (const listenerCleanup of listenerCleanups.reverse()) listenerCleanup();
		listenerCleanups.length = 0;
		for (const state of states.reverse()) {
			for (const variable of state.variables) variable.delete();
			state.root.replaceChildren();
		}
		states.length = 0;
	};
	signal.addEventListener("abort", cleanup, { once: true });

	try {
		const targetInputs = targetDefinition.inputs ?? [];
		for (const input of targetInputs) {
			if (!isPythonVariable(input)) defineLiveDependency(input);
		}
		for (const input of targetInputs) defineDependenciesForName(input);
	} catch (error) {
		signal.removeEventListener("abort", cleanup);
		cleanup();
		throw error;
	}

	function defineDependenciesForName(name: string): void {
		if (hasStandaloneDefinition(name)) return;
		if (isPythonVariable(name)) return;
		if (defineLiveDependency(name)) return;
		for (const index of dependencyCellIndexes(context, name, definitions)) defineDependencyCell(index);
		if (hasStandaloneDefinition(name)) return;
		if (notebookDefinesName(context, name) && defineParentRuntimeDependency(name)) return;
		if (runtime.main.defines(name)) return;
		defineParentRuntimeDependency(name);
	}

	function defineDependencyCell(index: number): void {
		if (index === context.cellIndex || defined.has(index) || defining.has(index)) return;
		if (!isSourceResolvableDependencyCell(context, index)) return;
		defining.add(index);
		try {
			const definition = transpileDependencyCell(context, definitions, index);
			const inputs = definition.inputs ?? [];
			for (const input of inputs) defineLiveDependency(input);
			for (const input of inputs) defineDependenciesForName(input);
			defined.add(index);

			const state: DefineState = {
				root: document.createElement("div"),
				expanded: [],
				variables: [],
			};
			states.push(state);
			const cell = context.notebook.cells[index];
			const runtimeDefinition = createRuntimeDefinition(cell, definition);
			const runtimeNames = runtimeVariableNames(definition);
			if (runtimeNames.some(hasStandaloneDefinition)) {
				defineMissingRuntimeVariables(runtime, state, runtimeDefinition, hasStandaloneDefinition);
			} else {
				runtime.define(state, runtimeDefinition, observe);
			}
			for (const name of runtimeNames) sourceDefined.add(name);
		} finally {
			defining.delete(index);
		}
	}

	function defineLiveDependency(name: string): boolean {
		if (isPythonVariable(name)) return false;
		if (liveDefined.has(name)) return true;
		const model = liveDependencyModel(context, name);
		if (!model) return false;
		const initialValues = readModelVariables(model);
		const hasCurrentLiveValue =
			Object.prototype.hasOwnProperty.call(initialValues, name) && canReviveDependencyValue(initialValues[name]);
		if (!hasCurrentLiveValue && dependencyCellIndexes(context, name, definitions).length > 0) return false;
		if (!hasCurrentLiveValue && parentRuntimeDefines(name)) return false;
		if (liveWatched.has(name)) return false;
		liveWatched.add(name);
		const defineCurrent = () => {
			const values = readModelVariables(model);
			if (!Object.prototype.hasOwnProperty.call(values, name)) return false;
			const value = values[name];
			if (!canReviveDependencyValue(value)) return false;
			defineLiveRuntimeVariable(name, value);
			liveDefined.add(name);
			return true;
		};
		if (!defineCurrent()) {
			// The sibling model may publish this value after the standalone
			// runtime starts. Define a rejecting placeholder so Observable
			// records the dependency until `_values` can redefine it.
			(runtime.main as RuntimeModule).define(name, [], () => Promise.reject(new Error(`${name} is not defined`)));
			liveDefined.add(name);
		}
		model.on("change:_values", defineCurrent);
		listenerCleanups.push(() => {
			model.off("change:_values", defineCurrent);
		});
		return true;
	}

	function defineLiveRuntimeVariable(name: string, value: unknown): void {
		const main = runtime.main as RuntimeModule;
		const define = () => reviveSyncedValue(value);
		try {
			main.redefine(name, [], define);
		} catch (error) {
			if (!isUndefinedRuntimeVariable(error, name)) throw error;
			main.define(name, [], define);
		}
	}

	function defineParentRuntimeDependency(name: string): boolean {
		if (hasStandaloneDefinition(name)) return true;
		if (!parentRuntimeDefines(name)) return false;
		// Browser-only dependencies such as functions stay inside Observable
		// Runtime. The standalone target still evaluates in its own output root.
		const variable = (runtime.main as RuntimeModule).import(name, context.runtime.main as RuntimeModule);
		listenerCleanups.push(() => variable.delete());
		liveDefined.add(name);
		return true;
	}

	function hasStandaloneDefinition(name: string): boolean {
		// Notebook builtins such as `svg` satisfy `main.defines`. Track only
		// values materialized for this standalone runtime so source cells can
		// shadow builtins.
		return liveDefined.has(name) || sourceDefined.has(name);
	}

	function isPythonVariable(name: string): boolean {
		return Object.prototype.hasOwnProperty.call(context.options.variables, name);
	}

	function parentRuntimeDefines(name: string): boolean {
		const main = (context.runtime as Partial<NotebookRuntime>).main;
		return typeof main?.defines === "function" && main.defines(name);
	}
}
