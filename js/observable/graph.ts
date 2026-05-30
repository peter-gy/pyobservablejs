import { transpile, type Notebook } from "@observablehq/notebook-kit";
import type { CellGraph, NotebookGraph } from "./types";

type Definition = ReturnType<typeof transpile>;

export function createNotebookGraph(notebook: Notebook, names: readonly string[] = []): NotebookGraph {
	const cells = notebook.cells.map((cell, index) => createCellGraph(cell, index, names[index] ?? ""));
	const definitions = new Map<string, CellGraph[]>();
	for (const cell of cells) {
		for (const name of definedNames(cell)) {
			const existing = definitions.get(name);
			if (existing) existing.push(cell);
			else definitions.set(name, [cell]);
		}
	}

	const edges = cells.flatMap((target) =>
		target.references.flatMap((name) =>
			(definitions.get(name) ?? [])
				.filter((source) => source.id !== target.id)
				.map((source) => ({
					from: source.id,
					to: target.id,
					variable: name,
				})),
		),
	);

	return { cells, edges };
}

export function exposedVariableNames(definition: Definition): string[] {
	if (definition.output) {
		if (definition.autoview) return [unprefix(definition.output, "viewof$")];
		if (definition.automutable) return [unprefix(definition.output, "mutable ")];
		return [definition.output];
	}
	return definition.outputs ?? [];
}

export function unprefix(value: string, prefix: string): string {
	return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function createCellGraph(notebookCell: Notebook["cells"][number], index: number, name: string): CellGraph {
	try {
		const definition = transpile(notebookCell, { resolveLocalImports: true });
		return {
			id: notebookCell.id,
			index,
			name,
			mode: notebookCell.mode,
			defines: exposedVariableNames(definition),
			references: definition.inputs ?? [],
			output: definition.output ?? null,
			outputs: definition.outputs ?? [],
			runtime_outputs: runtimeOutputs(definition),
			autodisplay: definition.autodisplay === true,
			autoview: definition.autoview === true,
			automutable: definition.automutable === true,
		};
	} catch (error) {
		return {
			id: notebookCell.id,
			index,
			name,
			mode: notebookCell.mode,
			defines: [],
			references: [],
			output: null,
			outputs: [],
			runtime_outputs: [],
			autodisplay: false,
			autoview: false,
			automutable: false,
			error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
		};
	}
}

function runtimeOutputs(definition: Definition): string[] {
	if (!definition.output) return definition.outputs ?? [];
	if (definition.automutable) return [definition.output, `mutable$${unprefix(definition.output, "mutable ")}`];
	return [definition.output];
}

function definedNames(cell: CellGraph): string[] {
	return Array.from(new Set([...cell.defines, ...cell.runtime_outputs]));
}
