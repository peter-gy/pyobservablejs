import { transpileNotebookImports } from "./notebook-imports";
import { resolveRuntimeImport } from "./import-code";
import { parseCell } from "@observablehq/parser";
import { transpile, type Cell, type Notebook } from "@observablehq/notebook-kit";
import { exposedVariableNames, runtimeOutputNames, viewVariableName, type RuntimeCellDefinition } from "./definition";
import type { RuntimeProfile } from "./source";
import { transpileObservableSql } from "./observable-sql";
import { observableTemplateCell } from "./observable-template";
export type CellGraph = Readonly<{
	id: number;
	index: number;
	key: string;
	mode: Cell["mode"];
	defines: readonly string[];
	references: readonly string[];
	output: string | null;
	outputs: readonly string[];
	runtimeOutputs: readonly string[];
	autodisplay: boolean;
	autoview: boolean;
	automutable: boolean;
	error?: string;
}>;

export type GraphEdge = Readonly<{
	from: number;
	to: number;
	variable: string;
}>;

export type NotebookGraph = Readonly<{
	cells: readonly CellGraph[];
	edges: readonly GraphEdge[];
}>;

type Definition = RuntimeCellDefinition;

type CellAnalysis =
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

type DependencyIndex = {
	sources: Map<number, number[]>;
	targets: Map<number, number[]>;
	names?: Map<string, number[]>;
};

// Analysis survives variable replacement; its dependency topology stays fixed.
const dependencyIndexes = new WeakMap<NotebookAnalysis, DependencyIndex>();

export function analyzeNotebook(
	notebook: Notebook,
	keys: readonly string[] = [],
	profile?: RuntimeProfile,
): NotebookAnalysis {
	const cells = notebook.cells.map((cell, index) => analyzeCell(cell, index, keys[index] ?? "", profile));
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
	return { cells, edges: analysis.graph.edges };
}

export function notebookViewNamesFromAnalysis(analysis: NotebookAnalysis): Set<string> {
	return new Set(analysis.viewNames);
}

export function notebookDefinedNamesFromAnalysis(analysis: NotebookAnalysis): ReadonlySet<string> {
	const names = new Set<string>();
	for (const cell of analysis.graph.cells) {
		for (const name of cell.defines) names.add(name);
		for (const name of cell.runtimeOutputs) names.add(name);
	}
	return names;
}

export function notebookDependencyIndexes(analysis: NotebookAnalysis, targetIndexes: Iterable<number>): Set<number> {
	return reachableIndexes(targetIndexes, dependencyIndex(analysis).sources);
}

export function notebookAffectedIndexes(analysis: NotebookAnalysis, variableNames: ReadonlySet<string>): Set<number> {
	const index = dependencyIndex(analysis);
	const names = (index.names ??= variableIndex(analysis));
	const roots = Array.from(variableNames).flatMap((name) => names.get(name) ?? []);
	return reachableIndexes(roots, index.targets);
}

function dependencyIndex(analysis: NotebookAnalysis): DependencyIndex {
	const cached = dependencyIndexes.get(analysis);
	if (cached) return cached;
	const sources = new Map<number, number[]>();
	const targets = new Map<number, number[]>();
	const indexById = new Map(analysis.graph.cells.map((cell) => [cell.id, cell.index]));
	for (const edge of analysis.graph.edges) {
		const source = indexById.get(edge.from);
		const target = indexById.get(edge.to);
		if (source === undefined || target === undefined) continue;
		appendIndex(sources, target, source);
		appendIndex(targets, source, target);
	}
	const index = { sources, targets };
	dependencyIndexes.set(analysis, index);
	return index;
}

function variableIndex(analysis: NotebookAnalysis): Map<string, number[]> {
	const names = new Map<string, number[]>();
	for (const cell of analysis.graph.cells) {
		for (const name of new Set([...cell.references, ...cell.defines, ...cell.runtimeOutputs]))
			appendIndex(names, name, cell.index);
	}
	return names;
}

function appendIndex<Key>(map: Map<Key, number[]>, key: Key, index: number): void {
	const indexes = map.get(key);
	if (indexes) indexes.push(index);
	else map.set(key, [index]);
}

function reachableIndexes(roots: Iterable<number>, neighbors: ReadonlyMap<number, readonly number[]>): Set<number> {
	const visited = new Set<number>();
	const pending = Array.from(roots);
	while (pending.length) {
		const index = pending.pop()!;
		if (visited.has(index)) continue;
		visited.add(index);
		for (const neighbor of neighbors.get(index) ?? []) pending.push(neighbor);
	}
	return visited;
}

function analyzeCell(cell: Cell, index: number, key: string, profile?: RuntimeProfile): CellAnalysis {
	try {
		const definition = transpileNotebookCell(cell, profile);
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

function transpileNotebookCell(cell: Cell, profile?: RuntimeProfile): RuntimeCellDefinition {
	if (profile === "observable" && cell.mode === "sql") return transpileObservableSql(cell);
	if (profile === "observable") cell = observableTemplateCell(cell);
	return addObservableImportWithInputs(
		cell,
		transpileNotebookImports(cell) ??
			transpile(cell, { resolveImport: resolveRuntimeImport, resolveLocalImports: true }),
	);
}

function analysisFromCells(cells: CellAnalysis[]): NotebookAnalysis {
	return {
		cells,
		graph: createGraphFromCells(cells.map((cell) => cell.graph)),
		viewNames: new Set(cells.map((cell) => cell.viewName).filter((name): name is string => name !== null)),
	};
}

function createGraphFromCells(cells: readonly CellGraph[]): NotebookGraph {
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
		mode: notebookCell.mode,
		defines: exposedVariableNames(definition),
		references: (definition.inputs ?? []).filter(
			(name) => !definition.imports?.some((imported) => imported.outputs?.includes(name)),
		),
		output: definition.output ?? null,
		outputs: definition.outputs ?? [],
		runtimeOutputs: runtimeOutputNames(definition),
		autodisplay: definition.autodisplay === true,
		autoview: definition.autoview === true,
		automutable: definition.automutable === true,
	};
}

function cellGraphFromError(
	notebookCell: Notebook["cells"][number],
	index: number,
	key: string,
	cause: unknown,
): CellGraph {
	return {
		id: notebookCell.id,
		index,
		key,
		mode: notebookCell.mode,
		defines: [],
		references: [],
		output: null,
		outputs: [],
		runtimeOutputs: [],
		autodisplay: false,
		autoview: false,
		automutable: false,
		error: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause),
	};
}

function definedNames(cell: CellGraph): string[] {
	return Array.from(new Set([...cell.defines, ...cell.runtimeOutputs]));
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
