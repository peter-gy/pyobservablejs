import type { Cell } from "@observablehq/notebook-kit";
import type { NotebookRuntime } from "@observablehq/notebook-kit/runtime";
import { createRuntimeDefinition, type RuntimeCellDefinition, type RuntimeDefinitionOptions } from "./definition";

type RuntimeDefinition = Parameters<NotebookRuntime["define"]>[1];
type RuntimeObserver = Parameters<NotebookRuntime["define"]>[2];
type RuntimeVariableObserver = Parameters<NotebookRuntime["main"]["variable"]>[0];
type RuntimeVariable = ReturnType<NotebookRuntime["main"]["variable"]>;

export type DefinedCell = {
	definition: RuntimeDefinition;
	variables: RuntimeVariable[];
};

export function defineRuntimeCell(
	runtime: NotebookRuntime,
	root: HTMLDivElement,
	cell: Cell,
	definition: RuntimeCellDefinition,
	observer?: RuntimeObserver,
	options?: RuntimeDefinitionOptions,
): DefinedCell {
	return defineCompiledRuntimeCell(runtime, root, createRuntimeDefinition(cell, definition, options), observer);
}

export function defineCompiledRuntimeCell(
	runtime: NotebookRuntime,
	root: HTMLDivElement,
	definition: RuntimeDefinition,
	observer?: RuntimeObserver,
): DefinedCell {
	const variables: RuntimeVariable[] = [];
	runtime.define({ root, expanded: [], variables }, definition, observer);
	return { definition, variables };
}

export function observeRuntimeVariable(
	runtime: NotebookRuntime,
	name: string,
	observer: RuntimeVariableObserver,
): RuntimeVariable {
	return runtime.main.variable(observer).define([name], (value: unknown) => value);
}
