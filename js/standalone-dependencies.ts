import { transpile } from "@observablehq/notebook-kit";
import { observe, type DefineState, type NotebookRuntime } from "@observablehq/notebook-kit/runtime";
import { createRuntimeDefinition, runtimeDefinitionNames, runtimeVariableNames } from "./runtime-definition";
import type { CellRenderContext, WidgetModel } from "./types";
import { readModelVariables, type AnyWidgetModel } from "./model-values";
import { reviveSyncedValue } from "./wire";

type RuntimeModule = NotebookRuntime["main"] & {
	define(...args: unknown[]): DefineState["variables"][number];
	redefine(...args: unknown[]): DefineState["variables"][number];
	import(...args: unknown[]): DefineState["variables"][number];
};

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

function isUndefinedRuntimeVariable(error: unknown, name: string): boolean {
	return error instanceof Error && error.message === `${name} is not defined`;
}

function defineMissingRuntimeVariables(
	runtime: NotebookRuntime,
	state: DefineState,
	definition: Parameters<NotebookRuntime["define"]>[1],
	hasStandaloneDefinition: (name: string) => boolean,
): void {
	const main = runtime.main as RuntimeModule;
	const sourceRuntime = createRuntimeModule(runtime);
	const sourceMain = sourceRuntime.main as RuntimeModule;
	const sourceImports: DefineState["variables"] = [];
	for (const input of definition.inputs ?? []) {
		if (!sourceRuntime.main.defines(input) && hasStandaloneDefinition(input)) {
			sourceImports.push(sourceMain.import(input, runtime.main));
		}
	}
	sourceRuntime.define(state, definition, observe);
	state.variables.push(...sourceImports);
	for (const name of runtimeDefinitionNames(definition)) {
		if (!hasStandaloneDefinition(name)) {
			state.variables.push(main.import(name, sourceRuntime.main));
		}
	}
}

function createRuntimeModule(runtime: NotebookRuntime): NotebookRuntime {
	const sourceRuntime = Object.create(Object.getPrototypeOf(runtime)) as NotebookRuntime;
	Object.defineProperties(sourceRuntime, {
		runtime: { value: runtime.runtime },
		main: { value: runtime.runtime.module() },
	});
	return sourceRuntime;
}

function dependencyCellIndexes(
	context: CellRenderContext,
	name: string,
	definitions: Map<number, TranspiledDefinition>,
): number[] {
	const graph = context.notebookModel.get("_graph");
	if (isNotebookGraphLike(graph)) {
		return graph.cells
			.filter((cell) => cell.index !== context.cellIndex)
			.filter((cell) => isSourceResolvableDependencyCell(context, cell.index))
			.filter((cell) => cell.defines.includes(name) || cell.runtime_outputs.includes(name))
			.map((cell) => cell.index);
	}
	const indexes: number[] = [];
	for (let index = 0; index < context.notebook.cells.length; index++) {
		if (index === context.cellIndex) continue;
		if (!isSourceResolvableDependencyCell(context, index)) continue;
		let definition: TranspiledDefinition;
		try {
			definition = transpileDependencyCell(context, definitions, index);
		} catch {
			continue;
		}
		if (runtimeVariableNames(definition).includes(name)) indexes.push(index);
	}
	return indexes;
}

function notebookDefinesName(context: CellRenderContext, name: string): boolean {
	const graph = context.notebookModel.get("_graph");
	if (isNotebookGraphLike(graph)) {
		return graph.cells.some(
			(cell) =>
				cell.index !== context.cellIndex && (cell.defines.includes(name) || cell.runtime_outputs.includes(name)),
		);
	}
	for (let index = 0; index < context.notebook.cells.length; index++) {
		if (index === context.cellIndex) continue;
		try {
			if (
				runtimeVariableNames(transpile(context.notebook.cells[index], { resolveLocalImports: true })).includes(name)
			) {
				return true;
			}
		} catch {
			continue;
		}
	}
	return false;
}

function isSourceResolvableDependencyCell(context: CellRenderContext, index: number): boolean {
	return context.notebook.cells[index]?.mode === "ojs";
}

function transpileDependencyCell(
	context: CellRenderContext,
	definitions: Map<number, TranspiledDefinition>,
	index: number,
): TranspiledDefinition {
	const existing = definitions.get(index);
	if (existing) return existing;
	const cell = context.notebook.cells[index];
	if (!cell) throw new Error(`Missing notebook cell at index ${index}`);
	const definition = transpile(cell, { resolveLocalImports: true });
	definitions.set(index, definition);
	return definition;
}

function liveDependencyModel(context: CellRenderContext, name: string): AnyWidgetModel | undefined {
	const valueMatches = context.cellModels.filter((model): model is AnyWidgetModel => {
		if (!model) return false;
		const values = readModelVariables(model);
		return Object.prototype.hasOwnProperty.call(values, name) && canReviveDependencyValue(values[name]);
	});
	if (valueMatches.length === 1) return valueMatches[0];
	if (valueMatches.length > 1) return undefined;
	const graph = context.notebookModel.get("_graph");
	if (!isNotebookGraphLike(graph)) return undefined;
	const graphMatches = graph.cells
		.filter((cell) => cell.index !== context.cellIndex)
		.filter((cell) => cell.defines.includes(name) || cell.runtime_outputs.includes(name))
		.map((cell) => context.cellModels[cell.index])
		.filter((model): model is AnyWidgetModel => model !== undefined);
	return graphMatches.length === 1 ? graphMatches[0] : undefined;
}

function canReviveDependencyValue(value: unknown): boolean {
	if (Array.isArray(value)) return value.every(canReviveDependencyValue);
	if (value === null || typeof value !== "object") return true;
	const record = value as Record<string, unknown>;
	const type = record.__pyobservablejs_type__;
	if (typeof type === "string") {
		if (
			["function", "element", "error", "regexp", "reference", "file", "blob", "arraybuffer", "typedarray"].includes(
				type,
			)
		) {
			return false;
		}
		if (type === "map" || type === "set") {
			return Array.isArray(record.value) && record.value.every(canReviveDependencyValue);
		}
		if (type === "object") return canReviveDependencyValue(record.value);
		return ["undefined", "number", "bigint", "datetime"].includes(type);
	}
	return Object.values(record).every(canReviveDependencyValue);
}

function isNotebookGraphLike(value: unknown): value is NonNullable<WidgetModel["_graph"]> {
	return (
		value !== null &&
		typeof value === "object" &&
		Array.isArray((value as { cells?: unknown }).cells) &&
		Array.isArray((value as { edges?: unknown }).edges)
	);
}
