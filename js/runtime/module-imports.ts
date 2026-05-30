import { observe, type DefineState, type NotebookRuntime } from "@observablehq/notebook-kit/runtime";
import { runtimeDefinitionNames } from "./definition";

export type RuntimeModule = NotebookRuntime["main"] & {
	define(...args: unknown[]): DefineState["variables"][number];
	redefine(...args: unknown[]): DefineState["variables"][number];
	import(...args: unknown[]): DefineState["variables"][number];
};

/**
 * Define a source cell in a scratch module when some of its names already exist
 * in the standalone runtime.
 */
export function defineMissingRuntimeVariables(
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

export function isUndefinedRuntimeVariable(error: unknown, name: string): boolean {
	return error instanceof Error && error.message === `${name} is not defined`;
}

function createRuntimeModule(runtime: NotebookRuntime): NotebookRuntime {
	const sourceRuntime = Object.create(Object.getPrototypeOf(runtime)) as NotebookRuntime;
	Object.defineProperties(sourceRuntime, {
		runtime: { value: runtime.runtime },
		main: { value: runtime.runtime.module() },
	});
	return sourceRuntime;
}
