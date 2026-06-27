import { transpile, type Cell, type Notebook } from "@observablehq/notebook-kit";

type RuntimeModule = {
	defines(name: string): boolean;
	derive(injections: ObservableImportInjection[], module: RuntimeModule): RuntimeModule;
	variable(observer: unknown): {
		import(name: string, module: RuntimeModule): void;
	};
};
type ObservableRuntime = {
	module(define?: unknown): RuntimeModule;
};
type RuntimeVariable = {
	_module: RuntimeModule;
};
type ObservableObserverFactory = () => unknown;
type ObservableImportSpecifier = {
	imported: string;
	local: string;
	runtimeName: string;
};
type ObservableImportInjection = {
	name: string;
	alias?: string;
};
type ObservableImportWith = {
	sourceUrl: string;
	imports: ObservableImportSpecifier[];
	injections: ObservableImportInjection[];
};
type RuntimeBody = (...values: unknown[]) => unknown;

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

type NotebookKitDefinition = ReturnType<typeof transpile>;
type Definition = Omit<NotebookKitDefinition, "body"> & {
	body: NotebookKitDefinition["body"] | RuntimeBody;
};

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
	return transpileObservableImportWith(cell) ?? transpile(cell, { resolveLocalImports: true });
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
		runtime_outputs: runtimeOutputs(definition),
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

function transpileObservableImportWith(cell: Cell): RuntimeCellDefinition | null {
	const parsed = parseObservableImportWith(cell);
	if (!parsed) return null;
	return {
		id: cell.id,
		body: async (
			__ojs_runtime: ObservableRuntime,
			__ojs_observer: ObservableObserverFactory,
			__variable: RuntimeVariable,
			..._injectionValues: unknown[]
		) => {
			void _injectionValues;
			const imported = (await import(/* @vite-ignore */ parsed.sourceUrl)) as { default: unknown };
			const source = __ojs_runtime.module(imported.default);
			const module = source.derive(parsed.injections, __variable._module);
			const main = __ojs_runtime.module();
			const observers: Record<string, unknown> = {};
			for (const specifier of parsed.imports) {
				if (!module.defines(specifier.runtimeName)) {
					throw new SyntaxError(`export '${specifier.runtimeName}' not found`);
				}
				const observer = __ojs_observer();
				observers[specifier.local] = observer;
				main.variable(observer).import(specifier.runtimeName, module);
			}
			return observers;
		},
		inputs: ["__ojs_runtime", "__ojs_observer", "@variable", ...parsed.injections.map((injection) => injection.name)],
		outputs: parsed.imports.map((specifier) => specifier.local),
		autodisplay: false,
	} as RuntimeCellDefinition;
}

function parseObservableImportWith(cell: Cell): ObservableImportWith | null {
	if (cell.mode !== "ojs") return null;
	const source = stripLeadingImportTrivia(cell.value);
	const match = source.match(
		/^\s*import\s*\{(?<imports>[\s\S]*?)\}\s+with\s*\{(?<injections>[\s\S]*?)\}\s+from\s*(?<quote>["'])(?<source>[^"']+)\k<quote>\s*;?\s*$/,
	);
	if (!match?.groups) return null;
	const imports = parseImportSpecifiers(match.groups.imports);
	const injections = parseImportInjections(match.groups.injections);
	if (imports.length === 0 || injections.length === 0) return null;
	return {
		sourceUrl: resolveObservableImportSource(match.groups.source),
		imports,
		injections,
	};
}

function stripLeadingImportTrivia(source: string): string {
	let value = source.trimStart();
	for (;;) {
		if (value.startsWith("//")) {
			const newline = value.indexOf("\n");
			if (newline === -1) return "";
			value = value.slice(newline + 1).trimStart();
			continue;
		}
		if (value.startsWith("/*")) {
			const end = value.indexOf("*/");
			if (end === -1) return "";
			value = value.slice(end + 2).trimStart();
			continue;
		}
		return value;
	}
}

function parseImportSpecifiers(source: string): ObservableImportSpecifier[] {
	return parseNamedEntries(source, { allowSpecial: true }).flatMap((entry) => importSpecifiersFromEntry(entry));
}

function parseImportInjections(source: string): ObservableImportInjection[] {
	return parseNamedEntries(source).map(({ name, alias }) => (alias ? { name, alias } : { name }));
}

type NamedEntry = { name: string; alias?: string; kind?: "mutable" | "viewof" };

function parseNamedEntries(source: string, options: { allowSpecial?: boolean } = {}): NamedEntry[] {
	return source
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map((entry) => {
			const special = options.allowSpecial ? "(?:(?<kind>viewof|mutable)\\s+)?" : "";
			const match = entry.match(
				new RegExp(`^${special}(?<name>[A-Za-z_$][0-9A-Za-z_$]*)(?:\\s+as\\s+(?<alias>[A-Za-z_$][0-9A-Za-z_$]*))?$`),
			);
			if (!match?.groups) throw new SyntaxError(`unsupported Observable import specifier: ${entry}`);
			return {
				name: match.groups.name,
				alias: match.groups.alias,
				kind: match.groups.kind as NamedEntry["kind"],
			};
		});
}

function importSpecifiersFromEntry(entry: NamedEntry): ObservableImportSpecifier[] {
	if (!entry.kind) {
		return [
			{
				imported: entry.name,
				local: entry.alias ?? entry.name,
				runtimeName: dedollar(entry.name),
			},
		];
	}
	const runtimeName = dedollar(entry.name);
	const localName = entry.alias ?? entry.name;
	const specialRuntimeName = `${entry.kind} ${runtimeName}`;
	const specialLocal = entry.kind === "viewof" ? `viewof$${localName}` : `mutable$${localName}`;
	return [
		{
			imported: entry.name,
			local: localName,
			runtimeName,
		},
		{
			imported: `${entry.kind} ${entry.name}`,
			local: specialLocal,
			runtimeName: specialRuntimeName,
		},
	];
}

function resolveObservableImportSource(source: string): string {
	if (source.startsWith("observable:")) {
		let path = source.slice("observable:".length);
		if (/^[0-9a-f]{16}(@|$)/.test(path)) path = `d/${path}`;
		return `https://api.observablehq.com/${path}.js?v=4`;
	}
	if (/^\w+:/.test(source)) return source;
	const path = /^[0-9a-f]{16}(@|$)/.test(source) ? `d/${source}` : source;
	return `https://api.observablehq.com/${path}.js?v=4`;
}

function dedollar(input: string): string {
	let output = "";
	let dollars = 0;
	for (const character of input) {
		if (character === "$") {
			dollars += 1;
			continue;
		}
		if (dollars > 0) {
			output += dollars === 1 ? " " : "$".repeat(dollars - 1);
			dollars = 0;
		}
		output += character;
	}
	if (dollars > 0) output += dollars === 1 ? " " : "$".repeat(dollars - 1);
	return output;
}
