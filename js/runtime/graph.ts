import { parseCell } from "@observablehq/parser";
import { transpile, type Cell, type Notebook } from "@observablehq/notebook-kit";
import { exposedVariableNames, runtimeOutputNames, viewVariableName, type RuntimeCellDefinition } from "./definition";
export type CellGraph = {
	id: number;
	index: number;
	key: string;
	name: string;
	mode: Cell["mode"];
	defines: string[];
	references: string[];
	output: string | null;
	outputs: string[];
	runtime_outputs: string[];
	autodisplay: boolean;
	autoview: boolean;
	automutable: boolean;
	error?: string;
};

export type GraphEdge = {
	from: number;
	to: number;
	variable: string;
};

export type NotebookGraph = {
	cells: CellGraph[];
	edges: GraphEdge[];
};

type Definition = RuntimeCellDefinition;

export type CellAnalysis =
	| {
			cell: Cell;
			index: number;
			definition: Definition;
			graph: CellGraph;
			viewName: string | null;
	  }
	| {
			cell: Cell;
			index: number;
			definition: null;
			graph: CellGraph;
			viewName: null;
			error: unknown;
	  };

export type NotebookAnalysis = {
	cells: CellAnalysis[];
	graph: NotebookGraph;
	viewNames: Set<string>;
};

export function analyzeNotebook(notebook: Notebook, keys: readonly string[] = []): NotebookAnalysis {
	const cells = notebook.cells.map((cell, index) => analyzeCell(cell, index, keys[index] ?? ""));
	return analysisFromCells(cells);
}

export function createNotebookGraph(notebook: Notebook, keys: readonly string[] = []): NotebookGraph {
	return analyzeNotebook(notebook, keys).graph;
}

export function createNotebookGraphFromAnalysis(
	analysis: NotebookAnalysis,
	keys: readonly string[] = [],
): NotebookGraph {
	if (keys.length === 0) return analysis.graph;
	const cells = analysis.graph.cells.map((cell, index) => ({
		...cell,
		key: keys[index] ?? "",
	}));
	return createGraphFromCells(cells);
}

export function notebookViewNamesFromAnalysis(analysis: NotebookAnalysis): Set<string> {
	return new Set(analysis.viewNames);
}

export function notebookDefinedNamesFromAnalysis(analysis: NotebookAnalysis): ReadonlySet<string> {
	const names = new Set<string>();
	for (const cell of analysis.graph.cells) {
		for (const name of cell.defines) names.add(name);
		for (const name of cell.runtime_outputs) names.add(name);
	}
	return names;
}

export function notebookDependencyIndexes(analysis: NotebookAnalysis, targetIndex: number): Set<number> {
	const indexById = new Map(analysis.graph.cells.map((cell) => [cell.id, cell.index]));
	const sourcesByTarget = new Map<number, number[]>();
	for (const edge of analysis.graph.edges) {
		const sourceIndex = indexById.get(edge.from);
		const target = indexById.get(edge.to);
		if (sourceIndex === undefined || target === undefined) continue;
		const sources = sourcesByTarget.get(target);
		if (sources) sources.push(sourceIndex);
		else sourcesByTarget.set(target, [sourceIndex]);
	}
	const indexes = new Set<number>();
	const visit = (index: number) => {
		if (indexes.has(index)) return;
		indexes.add(index);
		for (const source of sourcesByTarget.get(index) ?? []) visit(source);
	};
	visit(targetIndex);
	return indexes;
}

function analyzeCell(cell: Cell, index: number, key: string): CellAnalysis {
	try {
		const definition = transpileNotebookCell(cell);
		return {
			cell,
			index,
			definition,
			graph: cellGraphFromDefinition(cell, index, key, definition),
			viewName: viewVariableName(definition),
		};
	} catch (error) {
		return {
			cell,
			index,
			definition: null,
			graph: cellGraphFromError(cell, index, key, error),
			viewName: null,
			error,
		};
	}
}

export function transpileNotebookCell(cell: Cell): RuntimeCellDefinition {
	return addObservableImportWithInputs(cell, transpile(cell, { resolveLocalImports: true }));
}

function analysisFromCells(cells: CellAnalysis[]): NotebookAnalysis {
	return {
		cells,
		graph: createGraphFromCells(cells.map((cell) => cell.graph)),
		viewNames: new Set(cells.map((cell) => cell.viewName).filter((name): name is string => name !== null)),
	};
}

function createGraphFromCells(cells: CellGraph[]): NotebookGraph {
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

function cellGraphFromDefinition(
	notebookCell: Notebook["cells"][number],
	index: number,
	key: string,
	definition: Definition,
): CellGraph {
	return {
		id: notebookCell.id,
		index,
		key,
		name: notebookCellName(notebookCell),
		mode: notebookCell.mode,
		defines: exposedVariableNames(definition),
		references: definition.inputs ?? [],
		output: definition.output ?? null,
		outputs: definition.outputs ?? [],
		runtime_outputs: runtimeOutputNames(definition),
		autodisplay: definition.autodisplay === true,
		autoview: definition.autoview === true,
		automutable: definition.automutable === true,
	};
}

function cellGraphFromError(
	notebookCell: Notebook["cells"][number],
	index: number,
	key: string,
	error: unknown,
): CellGraph {
	return {
		id: notebookCell.id,
		index,
		key,
		name: notebookCellName(notebookCell),
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

function notebookCellName(cell: Notebook["cells"][number]): string {
	const name = (cell as { name?: unknown }).name;
	return typeof name === "string" ? name : "";
}

function definedNames(cell: CellGraph): string[] {
	return Array.from(new Set([...cell.defines, ...cell.runtime_outputs]));
}

function addObservableImportWithInputs(cell: Cell, definition: RuntimeCellDefinition): RuntimeCellDefinition {
	if (cell.mode !== "ojs" || !definition.inputs?.includes("@variable")) return definition;
	const inputs = Array.from(
		new Set([...(definition.inputs ?? []), ...parseCell(cell.value).references.map(({ name }) => name)]),
	);
	return {
		...definition,
		inputs,
	};
}
