import { transpile, type Cell } from "@observablehq/notebook-kit";
import type { Definition as RuntimeDefinition } from "@observablehq/notebook-kit/runtime";
import type { RuntimeProfile } from "./source";
import { bindNotebookImports, type ImportModule } from "./import-code";
import { isCallable, isString } from "./value-kind";

type NotebookKitDefinition = ReturnType<typeof transpile>;
type RuntimeBody = RuntimeDefinition["body"];
type RuntimeReceiver = ThisParameterType<RuntimeBody>;
type RuntimeArguments = Parameters<RuntimeBody>;

export type RuntimeCellDefinition = Omit<NotebookKitDefinition, "body"> & {
	body: NotebookKitDefinition["body"] | RuntimeBody;
	display?: RuntimeDefinition["display"];
	rootInput?: number;
	imports?: RuntimeCellDefinition[];
};

interface DisplayOverride {
	display?: false;
}

export type RuntimeDefinitionOptions = {
	importModule?: ImportModule;
	document?: Document;
	notebookNames?: ReadonlySet<string>;
	runtimeProfile?: RuntimeProfile;
	root?: HTMLDivElement;
};

export function createRuntimeDefinition(
	cell: Cell,
	definition: RuntimeCellDefinition,
	options: RuntimeDefinitionOptions = {},
): RuntimeDefinition {
	const { notebookNames, runtimeProfile, root, ...globals } = options;
	let body = compileRuntimeBody(definition.body, globals);
	if (definition.rootInput !== undefined) {
		if (!root) throw new Error("A compiled cell renderer requires its output root");
		body = bindOutputRoot(body, definition.rootInput, root);
	}
	return {
		id: cell.id,
		body,
		inputs: definition.inputs,
		outputs: definition.outputs,
		output: definition.output,
		autodisplay: definition.autodisplay,
		autoview: definition.autoview,
		automutable: definition.automutable,
		display: definition.display,
		displayMode: cell.mode === "sql" ? "table" : "default",
		...observableDisplayOverride(definition, notebookNames, runtimeProfile),
	};
}

function bindOutputRoot(body: RuntimeBody, index: number, root: HTMLDivElement): RuntimeBody {
	// Compiler-owned rendering must not shadow authored display or view inputs.
	return function (this: RuntimeReceiver, ...values: RuntimeArguments) {
		values.splice(index, 0, root);
		return body.call(this, ...values);
	};
}

export function exposedVariableNames(definition: RuntimeCellDefinition): string[] {
	if (definition.output) {
		if (definition.autoview) return [unprefix(definition.output, "viewof$")];
		if (definition.automutable) return [unprefix(definition.output, "initial ")];
		return [definition.output];
	}
	return definition.outputs ?? [];
}

export function runtimeOutputNames(definition: RuntimeCellDefinition): string[] {
	if (!definition.output) return definition.outputs ?? [];
	if (definition.automutable) {
		return [definition.output, `mutable$${unprefix(definition.output, "initial ")}`];
	}
	return [definition.output];
}

export function viewVariableName(definition: RuntimeCellDefinition): string | null {
	if (!definition.autoview || !definition.output) return null;
	return unprefix(definition.output, "viewof$");
}

function unprefix(value: string, prefix: string): string {
	return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function compileRuntimeBody(
	source: RuntimeCellDefinition["body"],
	globals: { document?: Document; importModule?: ImportModule },
): RuntimeBody {
	if (!isString(source)) return source;
	const names: string[] = [];
	const values: (Document | ImportModule)[] = [];
	if (source.includes("import")) {
		const imports = bindNotebookImports(source, globals.importModule);
		source = imports.source;
		names.push(imports.name);
		values.push(imports.load);
	}
	if (globals.document !== undefined) {
		names.push("document");
		values.push(globals.document);
	}
	const body: unknown = new Function(...names, `"use strict"; return (${source});`)(...values);
	if (!isCallable(body)) throw new TypeError("Notebook cell body must compile to a function");
	// SAFETY: Notebook Kit supplies a cell function whose inputs and result are JavaScript runtime values.
	return body as RuntimeBody;
}

function observableDisplayOverride(
	definition: RuntimeCellDefinition,
	notebookNames: ReadonlySet<string> | undefined,
	profile: RuntimeProfile | undefined,
): DisplayOverride {
	if (profile !== "observable" || !notebookNames) return {};
	const ownNames = definitionNames(definition);
	const usesNotebookDisplayName = (definition.inputs ?? []).some(
		(name) => (name === "display" || name === "view") && notebookNames.has(name) && !ownNames.has(name),
	);
	return usesNotebookDisplayName ? { display: false } : {};
}

function definitionNames(definition: RuntimeCellDefinition): Set<string> {
	const names = new Set(definition.outputs ?? []);
	if (!definition.output) return names;
	names.add(definition.output);
	if (definition.autoview) names.add(unprefix(definition.output, "viewof$"));
	if (definition.automutable) {
		const name = unprefix(definition.output, "initial ");
		names.add(name);
		names.add(`mutable$${name}`);
	}
	return names;
}
