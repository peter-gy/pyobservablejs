import {
	deserialize,
	parseJavaScript,
	resolveImportDefault,
	toNotebook,
	transpileTemplate,
	type Cell,
	type Notebook,
	type NotebookSpec,
} from "@observablehq/notebook-kit";
import { parseCell } from "@observablehq/parser";
import { simple, base, type RecursiveVisitors } from "acorn-walk";
import type { AnyNode, ImportDeclaration, ImportSpecifier } from "acorn";
import type { AttachmentInfo } from "./attachment-info";
import type { RuntimeProfile } from "./environment";
import { analyzeNotebook, type CellGraph, type NotebookAnalysis, type NotebookGraph } from "./graph";
import { isString } from "./value-kind";
import { observableTemplateCell } from "./observable-template";

export type ImportBinding = Readonly<{ imported: string; local: string }>;
export type NotebookImport = Readonly<{
	cell: number;
	kind: "static" | "dynamic";
	source: string | null;
	resolved: string | null;
	bindings: readonly ImportBinding[];
	injections: readonly ImportBinding[];
}>;
export type CellInspection = CellGraph &
	Readonly<{
		source: string;
		pinned: boolean;
		hidden: boolean;
		files: readonly string[];
		databases: readonly string[];
		secrets: readonly string[];
	}>;
export type AttachmentInspection = Readonly<{
	name: string;
	url: string | null;
	mimeType?: string;
	size?: number;
	lastModified?: number;
	cells: readonly number[];
}>;
export type InspectOptions = {
	keys?: readonly string[];
	attachments?: Readonly<Record<string, AttachmentInfo>>;
	runtimeProfile?: RuntimeProfile;
};
export type NotebookInspection = Readonly<{
	title: string;
	theme: Notebook["theme"];
	runtimeProfile: RuntimeProfile;
	cells: readonly CellInspection[];
	graph: NotebookGraph;
	attachments: readonly AttachmentInspection[];
	imports: readonly NotebookImport[];
}>;

export function inspectNotebook(source: string | NotebookSpec, options: InspectOptions = {}): NotebookInspection {
	const notebook = isString(source) ? deserialize(source) : toNotebook(source);
	return inspectAnalysis(notebook, analyzeNotebook(notebook, options.keys, options.runtimeProfile), options);
}

export function inspectAnalysis(
	notebook: Notebook,
	analysis: NotebookAnalysis,
	options: InspectOptions = {},
): NotebookInspection {
	const imports: NotebookImport[] = [];
	const cells = analysis.cells.map(({ cell, definition, graph }, index) => {
		// Template metadata can also contribute expressions to the generated source.
		if (
			definition &&
			(cell.value.includes("import") || cell.output?.includes("import") || cell.database?.includes("import"))
		)
			imports.push(
				...cellImports(options.runtimeProfile === "observable" ? observableTemplateCell(cell) : cell, index),
			);
		return Object.freeze({
			...graph,
			key: options.keys?.[index] ?? graph.key,
			defines: Object.freeze([...graph.defines]),
			references: Object.freeze([...graph.references]),
			outputs: Object.freeze([...graph.outputs]),
			runtimeOutputs: Object.freeze([...graph.runtimeOutputs]),
			source: cell.value,
			pinned: cell.pinned,
			hidden: cell.hidden,
			files: Object.freeze([...(definition?.files ?? [])]),
			databases: Object.freeze([...(definition?.databases ?? [])]),
			secrets: Object.freeze([...(definition?.secrets ?? [])]),
		});
	});
	const names = new Set([...Object.keys(options.attachments ?? {}), ...cells.flatMap((cell) => cell.files)]);
	const attachments = [...names].map((name) =>
		Object.freeze({
			name,
			url: options.attachments?.[name]?.url ?? null,
			...options.attachments?.[name],
			cells: Object.freeze(cells.filter((cell) => cell.files.includes(name)).map((cell) => cell.index)),
		}),
	);
	return Object.freeze({
		title: notebook.title,
		theme: isString(notebook.theme) ? notebook.theme : Object.freeze({ ...notebook.theme }),
		runtimeProfile: options.runtimeProfile ?? "notebook-kit",
		cells: Object.freeze(cells),
		graph: Object.freeze({
			cells: Object.freeze(
				cells.map(
					({
						source: _source,
						pinned: _pinned,
						hidden: _hidden,
						files: _files,
						databases: _databases,
						secrets: _secrets,
						...cell
					}) => Object.freeze(cell),
				),
			),
			edges: Object.freeze(analysis.graph.edges.map((edge) => Object.freeze({ ...edge }))),
		}),
		attachments: Object.freeze(attachments),
		imports: Object.freeze(imports),
	});
}

type ObservableSpecifier = ImportSpecifier & { view?: boolean; mutable?: boolean };
type ObservableImport = ImportDeclaration & { injections?: ObservableSpecifier[] };

function cellImports(cell: Cell, index: number): NotebookImport[] {
	const node =
		cell.mode === "ojs"
			? parseCell(cell.value).body
			: cell.mode === "js" || cell.mode === "ts"
				? parseJavaScript(cell.value, cell.mode).body
				: parseJavaScript(transpileTemplate(cell)).body;
	if (!node) return [];
	const imports: NotebookImport[] = [];
	simple(
		node,
		{
			ImportDeclaration(declaration) {
				if ("importKind" in declaration && declaration.importKind === "type") return;
				const source = String(declaration.source.value);
				const resolved = resolveImportDefault(
					cell.mode === "ojs" && !/^\w+:/.test(source) ? `observable:${source}` : source,
				);
				// SAFETY: Observable's import AST extends Acorn with view, mutable, and injection bindings.
				const observable = declaration as ObservableImport;
				imports.push(
					freezeImport({
						cell: index,
						kind: "static",
						source,
						resolved,
						bindings: declaration.specifiers
							.filter((specifier) => !("importKind" in specifier) || specifier.importKind !== "type")
							.map((specifier) => {
								if (specifier.type === "ImportNamespaceSpecifier")
									return { imported: "*", local: specifier.local.name };
								if (specifier.type === "ImportDefaultSpecifier")
									return { imported: "default", local: specifier.local.name };
								return importBinding(specifier);
							}),
						injections: observable.injections?.map(importBinding) ?? [],
					}),
				);
			},
			ImportExpression(expression) {
				const source = constantString(expression.source);
				let resolved = source;
				if (source !== null) {
					if (cell.mode !== "ojs") resolved = resolveImportDefault(source);
					else if (!/^(\w+:|\.?\.?\/)/.test(source))
						resolved = resolveImportDefault(`npm:${source}${/\.(js|mjs|cjs)$/.test(source) ? "/+esm" : ""}`);
				}
				imports.push(freezeImport({ cell: index, kind: "dynamic", source, resolved, bindings: [], injections: [] }));
			},
		},
		templateWalker,
	);
	return imports;
}

function constantString(node: AnyNode): string | null {
	if (node.type === "Literal") return isString(node.value) ? node.value : null;
	if (node.type === "BinaryExpression" && node.operator === "+") {
		const left = constantString(node.left);
		const right = constantString(node.right);
		return left === null || right === null ? null : left + right;
	}
	if (node.type === "TemplateLiteral") {
		let value = node.quasis[0]?.value.cooked;
		if (!isString(value)) return null;
		for (let index = 0; index < node.expressions.length; index++) {
			const part = constantString(node.expressions[index]!);
			const suffix = node.quasis[index + 1]?.value.cooked;
			if (part === null || !isString(suffix)) return null;
			value += part + suffix;
		}
		return value;
	}
	return null;
}

function importBinding(specifier: ObservableSpecifier): ImportBinding {
	const prefix = specifier.view ? "viewof " : specifier.mutable ? "mutable " : "";
	const imported =
		specifier.imported.type === "Identifier" ? specifier.imported.name : String(specifier.imported.value);
	return { imported: prefix + imported, local: prefix + specifier.local.name };
}

function freezeImport(value: NotebookImport): NotebookImport {
	return Object.freeze({
		...value,
		bindings: Object.freeze(value.bindings.map((binding) => Object.freeze(binding))),
		injections: Object.freeze(value.injections.map((binding) => Object.freeze(binding))),
	});
}

const expressionNode: NonNullable<RecursiveVisitors<undefined>["Expression"]> = (node, state, visit) => {
	// SAFETY: These parser extensions wrap an expression and carry erased type metadata.
	visit((node as AnyNode & { expression: AnyNode }).expression, state);
};
const templateWalker = {
	...base,
	ViewExpression() {},
	MutableExpression() {},
	TSInterfaceDeclaration() {},
	TSTypeAliasDeclaration() {},
	TSDeclareFunction() {},
	TSDeclareMethod() {},
	TSIndexSignature() {},
	TSNamespaceExportDeclaration() {},
	TSEnumDeclaration() {},
	TSModuleDeclaration() {},
	TSImportEqualsDeclaration() {},
	TSExportAssignment() {},
	TSAsExpression: expressionNode,
	TSTypeAssertion: expressionNode,
	TSNonNullExpression: expressionNode,
	TSSatisfiesExpression: expressionNode,
	TSInstantiationExpression: expressionNode,
	TSTypeCastExpression: expressionNode,
};
