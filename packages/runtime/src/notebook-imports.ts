import { parseJavaScript, transpile, type Cell } from "@observablehq/notebook-kit";
import { resolveRuntimeImport } from "./import-code";
import { isString } from "./value-kind";
import type { RuntimeCellDefinition } from "./definition";

export function transpileNotebookImports(cell: Cell): RuntimeCellDefinition | null {
	if (cell.mode !== "js" && cell.mode !== "ts") return null;
	if (!cell.value.includes("import")) return null;
	const parsed = parseJavaScript(cell.value, cell.mode);
	if (parsed.body.type !== "Program") return null;
	const imports: RuntimeCellDefinition[] = [];
	const edits: { start: number; end: number; value: string }[] = [];
	let bindingIndex = 0;
	let prefix = `__notebookBinding${String(cell.id).replace("-", "_")}_`;
	while (cell.value.includes(prefix)) prefix += "_";
	for (const node of parsed.body.body) {
		if (node.type !== "ImportDeclaration" || !isString(node.source.value)) continue;
		if ("importKind" in node && node.importKind === "type") continue;
		const type = node.attributes?.find(
			(attribute) => (attribute.key.type === "Identifier" ? attribute.key.name : attribute.key.value) === "type",
		);
		const observable = type ? type.value.value === "observable" : node.source.value.startsWith("observable:");
		if (!observable) continue;
		let statement = cell.value.slice(node.start, node.end);
		const bindings = node.specifiers
			.filter((specifier) => !("importKind" in specifier && specifier.importKind === "type"))
			.map((specifier) => {
				const local = specifier.local.name;
				const name = `${prefix}${bindingIndex++}`;
				return { specifier, local, name };
			});
		for (const { specifier, name } of [...bindings].reverse()) {
			const replacement =
				specifier.type === "ImportSpecifier" && specifier.imported.start === specifier.local.start
					? `${cell.value.slice(specifier.imported.start, specifier.imported.end)} as ${name}`
					: name;
			const start = specifier.local.start - node.start;
			const end = specifier.local.end - node.start;
			statement = statement.slice(0, start) + replacement + statement.slice(end);
		}
		const definition = transpile(
			{ ...cell, value: statement },
			{ resolveImport: resolveRuntimeImport, resolveLocalImports: true },
		);
		imports.push(definition);
		edits.push({
			start: node.start,
			end: node.end,
			value: bindings.map(({ local, name }) => `const ${local} = ${name};`).join("\n"),
		});
	}
	if (!imports.length) return null;
	let source = cell.value;
	for (const edit of edits.reverse()) source = source.slice(0, edit.start) + edit.value + source.slice(edit.end);
	const definition = transpile(
		{ ...cell, value: source },
		{ resolveImport: resolveRuntimeImport, resolveLocalImports: true },
	);
	return { ...definition, imports };
}
