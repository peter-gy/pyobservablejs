import { transpile } from "@observablehq/notebook-kit";
import { readModelVariables, type AnyWidgetModel } from "../model/values";
import type { WidgetModel } from "../model/types";
import { runtimeVariableNames } from "../runtime/definition";
import type { CellRenderContext } from "./types";

type TranspiledDefinition = ReturnType<typeof transpile>;

/**
 * Return source-backed OJS cell indexes that can define `name` for a standalone cell.
 */
export function dependencyCellIndexes(
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

export function notebookDefinesName(context: CellRenderContext, name: string): boolean {
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

export function isSourceResolvableDependencyCell(context: CellRenderContext, index: number): boolean {
	return context.notebook.cells[index]?.mode === "ojs";
}

export function transpileDependencyCell(
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

/**
 * Select the sibling model that can provide a browser-revivable live value.
 */
export function liveDependencyModel(context: CellRenderContext, name: string): AnyWidgetModel | undefined {
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

export function canReviveDependencyValue(value: unknown): boolean {
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
