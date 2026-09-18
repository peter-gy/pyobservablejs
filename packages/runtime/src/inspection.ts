import { normalizeNotebook } from "./source";
import {
	parseJavaScript,
	resolveImportDefault,
	transpileTemplate,
	type Cell,
	type Notebook,
	type NotebookSpec,
} from "@observablehq/notebook-kit";
import type { NotebookOrigin } from "./source";
import { notebookReference, resolveNotebookReference, notebookSourceUrl } from "./import-code";
import { parseCell } from "@observablehq/parser";
import { simple, base, type RecursiveVisitors } from "acorn-walk";
import type { AnyNode, ImportDeclaration, ImportSpecifier } from "acorn";
import type { AttachmentInfo } from "./attachment-info";
import type { RuntimeProfile } from "./source";
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
		urls: readonly string[];
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
	origin?: NotebookOrigin;
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
	const normalized = normalizeNotebook(source, options);
	options = { ...options, runtimeProfile: normalized.runtimeProfile, origin: normalized.origin };
	return inspectAnalysis(
		normalized.notebook,
		analyzeNotebook(normalized.notebook, options.keys, options.runtimeProfile),
		options,
	);
}

export function inspectAnalysis(
	notebook: Notebook,
	analysis: NotebookAnalysis,
	options: InspectOptions = {},
): NotebookInspection {
	const imports: NotebookImport[] = [];
	const cells = analysis.cells.map(({ cell, definition, graph }, index) => {
		const references = definition
			? cellReferences(
					options.runtimeProfile === "observable" ? observableTemplateCell(cell) : cell,
					index,
					options.origin,
				)
			: { imports: [], urls: [] };
		imports.push(...references.imports);
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
			urls: Object.freeze(references.urls),
			databases: Object.freeze([...(definition?.databases ?? [])]),
			secrets: Object.freeze([...(definition?.secrets ?? [])]),
		});
	});
	const fileCells = new Map<string, number[]>(Object.keys(options.attachments ?? {}).map((name) => [name, []]));
	for (const cell of cells) {
		for (const name of cell.files) {
			const indexes = fileCells.get(name);
			if (indexes) indexes.push(cell.index);
			else fileCells.set(name, [cell.index]);
		}
	}
	const attachments = Array.from(fileCells, ([name, indexes]) =>
		Object.freeze({
			name,
			url: options.attachments?.[name]?.url ?? (/^(https?:|data:)/.test(name) ? name : null),
			...options.attachments?.[name],
			cells: Object.freeze(indexes),
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
						urls: _urls,
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

function cellReferences(cell: Cell, index: number, origin?: NotebookOrigin) {
	const resolve = (source: string) => {
		const resolved = resolveImportDefault(source);
		const reference = notebookReference(resolved);
		return reference === null ? resolved : notebookSourceUrl(resolveNotebookReference(reference, origin));
	};
	const node =
		cell.mode === "ojs"
			? parseCell(cell.value).body
			: cell.mode === "js" || cell.mode === "ts"
				? parseJavaScript(cell.value, cell.mode).body
				: parseJavaScript(transpileTemplate(cell)).body;
	if (!node) return { imports: [], urls: [] };
	const imports: NotebookImport[] = [];
	const urls = new Set<string>();
	simple(
		node,
		{
			CallExpression(call) {
				const target = call.callee;
				const fetch = target.type === "Identifier" && target.name === "fetch";
				const loader =
					target.type === "MemberExpression" &&
					target.object.type === "Identifier" &&
					target.object.name === "d3" &&
					!target.computed &&
					target.property.type === "Identifier" &&
					["csv", "tsv", "json", "text", "xml"].includes(target.property.name);
				if (!fetch && !loader) return;
				const argument = call.arguments[0];
				if (!argument) return;
				const url = constantString(argument);
				if (url !== null) urls.add(url);
			},
			ImportDeclaration(declaration) {
				if ("importKind" in declaration && declaration.importKind === "type") return;
				const source = String(declaration.source.value);
				const resolved = resolve(cell.mode === "ojs" && !/^\w+:/.test(source) ? `observable:${source}` : source);
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
					if (cell.mode !== "ojs") resolved = resolve(source);
					else if (!/^(\w+:|\.?\.?\/)/.test(source))
						resolved = resolve(`npm:${source}${/\.(js|mjs|cjs)$/.test(source) ? "/+esm" : ""}`);
				}
				imports.push(freezeImport({ cell: index, kind: "dynamic", source, resolved, bindings: [], injections: [] }));
			},
		},
		templateWalker,
	);
	return { imports, urls: [...urls] };
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
