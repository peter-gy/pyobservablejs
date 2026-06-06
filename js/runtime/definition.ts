import { transpile, type Cell } from "@observablehq/notebook-kit";
import type { NotebookRuntime } from "@observablehq/notebook-kit/runtime";
import { exposedVariableNames, unprefix } from "../observable/graph";

type RuntimeDefinition = Parameters<NotebookRuntime["define"]>[1];
type RuntimeBody = RuntimeDefinition["body"];
type TranspiledDefinition = ReturnType<typeof transpile>;

const TEMPLATE_MODES = new Set<Cell["mode"]>(["dot", "html", "md", "sql", "tex"]);

export function createRuntimeDefinition(cell: Cell, definition: TranspiledDefinition): RuntimeDefinition {
	const body = new Function(`"use strict"; return (${definition.body});`)() as RuntimeBody;
	return {
		id: cell.id,
		body: TEMPLATE_MODES.has(cell.mode) ? awaitTemplateInputs(body) : body,
		inputs: definition.inputs,
		outputs: definition.outputs,
		output: definition.output,
		autodisplay: definition.autodisplay,
		autoview: definition.autoview,
		automutable: definition.automutable,
	};
}

function awaitTemplateInputs(body: RuntimeBody): RuntimeBody {
	return async function (this: unknown, ...values: unknown[]) {
		return body.call(this, ...(await Promise.all(values)));
	} as RuntimeBody;
}

export function runtimeDefinitionNames(definition: RuntimeDefinition): string[] {
	const names = new Set<string>();
	if (definition.output) {
		names.add(definition.output);
		if (definition.autoview) names.add(unprefix(definition.output, "viewof$"));
		if (definition.automutable) {
			const name = unprefix(definition.output, "mutable ");
			names.add(name);
			names.add(`mutable$${name}`);
		}
	} else {
		for (const name of definition.outputs ?? []) names.add(name);
	}
	return Array.from(names);
}

export function runtimeVariableNames(definition: TranspiledDefinition): string[] {
	const names = new Set(exposedVariableNames(definition));
	if (definition.output) {
		names.add(definition.output);
		if (definition.automutable) names.add(`mutable$${unprefix(definition.output, "mutable ")}`);
	} else {
		for (const name of definition.outputs ?? []) names.add(name);
	}
	return Array.from(names);
}
