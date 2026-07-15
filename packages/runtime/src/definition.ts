import { transpile, type Cell } from "@observablehq/notebook-kit";
import type { NotebookRuntime } from "@observablehq/notebook-kit/runtime";
import type { RuntimeProfile } from "./environment";

type NotebookKitDefinition = ReturnType<typeof transpile>;
type RuntimeBody = (...values: unknown[]) => unknown;
type RuntimeDefinition = Parameters<NotebookRuntime["define"]>[1];

export type RuntimeCellDefinition = Omit<NotebookKitDefinition, "body"> & {
	body: NotebookKitDefinition["body"] | RuntimeBody;
};

export type RuntimeDefinitionOptions = {
	document?: Document;
	notebookNames?: ReadonlySet<string>;
	runtimeProfile?: RuntimeProfile;
};

const TEMPLATE_MODES = new Set<Cell["mode"]>(["dot", "html", "md", "sql", "tex"]);

export function createRuntimeDefinition(
	cell: Cell,
	definition: RuntimeCellDefinition,
	options: RuntimeDefinitionOptions = {},
): RuntimeDefinition {
	const { notebookNames, runtimeProfile, ...globals } = options;
	const body = compileRuntimeBody(definition.body, globals);
	return {
		id: cell.id,
		body: TEMPLATE_MODES.has(cell.mode) ? awaitTemplateInputs(body) : body,
		inputs: definition.inputs,
		outputs: definition.outputs,
		output: definition.output,
		autodisplay: definition.autodisplay,
		autoview: definition.autoview,
		automutable: definition.automutable,
		display: (definition as RuntimeDefinition).display,
		...observableDisplayOverride(definition, notebookNames, runtimeProfile),
	};
}

export function exposedVariableNames(definition: RuntimeCellDefinition): string[] {
	if (definition.output) {
		if (definition.autoview) return [unprefix(definition.output, "viewof$")];
		if (definition.automutable) return [unprefix(definition.output, "mutable ")];
		return [definition.output];
	}
	return definition.outputs ?? [];
}

export function runtimeOutputNames(definition: RuntimeCellDefinition): string[] {
	if (!definition.output) return definition.outputs ?? [];
	if (definition.automutable) {
		return [definition.output, `mutable$${unprefix(definition.output, "mutable ")}`];
	}
	return [definition.output];
}

export function viewVariableName(definition: RuntimeCellDefinition): string | null {
	if (!definition.autoview || !definition.output) return null;
	return unprefix(definition.output, "viewof$");
}

export function unprefix(value: string, prefix: string): string {
	return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function compileRuntimeBody(source: RuntimeCellDefinition["body"], globals: { document?: Document }): RuntimeBody {
	if (typeof source === "function") return source as RuntimeBody;
	const entries = Object.entries(globals).filter((entry) => entry[1] !== undefined) as [string, unknown][];
	const names = entries.map(([name]) => name);
	const values = entries.map(([, value]) => value);
	return new Function(...names, `"use strict"; return (${source});`)(...values) as RuntimeBody;
}

function awaitTemplateInputs(body: RuntimeBody): RuntimeBody {
	return async function (this: unknown, ...values: unknown[]) {
		return body.call(this, ...(await Promise.all(values)));
	} as RuntimeBody;
}

function observableDisplayOverride(
	definition: RuntimeCellDefinition,
	notebookNames: ReadonlySet<string> | undefined,
	profile: RuntimeProfile | undefined,
): { display?: false } {
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
		const name = unprefix(definition.output, "mutable ");
		names.add(name);
		names.add(`mutable$${name}`);
	}
	return names;
}
