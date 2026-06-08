import { transpile, type Cell, type Notebook } from "@observablehq/notebook-kit";

export type CellGraph = {
	id: number;
	index: number;
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

type Definition = ReturnType<typeof transpile>;

export type RuntimeCellDefinition = Definition;

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

export function analyzeNotebook(notebook: Notebook, names: readonly string[] = []): NotebookAnalysis {
	const cells = notebook.cells.map((cell, index) => analyzeCell(cell, index, names[index] ?? ""));
	return analysisFromCells(cells);
}

export function createNotebookGraph(notebook: Notebook, names: readonly string[] = []): NotebookGraph {
	return analyzeNotebook(notebook, names).graph;
}

export function createNotebookGraphFromAnalysis(
	analysis: NotebookAnalysis,
	names: readonly string[] = [],
): NotebookGraph {
	if (names.length === 0) return analysis.graph;
	const cells = analysis.graph.cells.map((cell, index) => ({
		...cell,
		name: names[index] ?? "",
	}));
	return createGraphFromCells(cells);
}

export function notebookViewNamesFromAnalysis(analysis: NotebookAnalysis): Set<string> {
	return new Set(analysis.viewNames);
}

function analyzeCell(cell: Cell, index: number, name: string): CellAnalysis {
	try {
		const definition = transpile(cell, { resolveLocalImports: true });
		return {
			cell,
			index,
			definition,
			graph: cellGraphFromDefinition(cell, index, name, definition),
			viewName: viewVariableName(definition),
		};
	} catch (error) {
		return {
			cell,
			index,
			definition: null,
			graph: cellGraphFromError(cell, index, name, error),
			viewName: null,
			error,
		};
	}
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

function cellGraphFromDefinition(
	notebookCell: Notebook["cells"][number],
	index: number,
	name: string,
	definition: Definition,
): CellGraph {
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
}

function cellGraphFromError(
	notebookCell: Notebook["cells"][number],
	index: number,
	name: string,
	error: unknown,
): CellGraph {
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

function runtimeOutputs(definition: Definition): string[] {
	if (!definition.output) return definition.outputs ?? [];
	if (definition.automutable) return [definition.output, `mutable$${unprefix(definition.output, "mutable ")}`];
	return [definition.output];
}

function definedNames(cell: CellGraph): string[] {
	return Array.from(new Set([...cell.defines, ...cell.runtime_outputs]));
}

function viewVariableName(definition: Definition): string | null {
	if (!definition.autoview || !definition.output) return null;
	return unprefix(definition.output, "viewof$");
}
