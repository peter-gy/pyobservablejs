import type { NotebookOrigin } from "./source";
import { isString } from "./value-kind";
import { parseJavaScript, resolveImportDefault } from "@observablehq/notebook-kit";
import { simple } from "acorn-walk";
import type { ModuleDefinition } from "@observablehq/runtime";

export type ImportModule = (specifier: string) => Promise<{ default: ModuleDefinition }>;

const RUNTIME_NOTEBOOK_PROTOCOL = "observablejs:";

export function notebookReference(specifier: string): string | null {
	if (specifier.startsWith(RUNTIME_NOTEBOOK_PROTOCOL)) return specifier.slice(RUNTIME_NOTEBOOK_PROTOCOL.length);
	if (specifier.startsWith("observable:")) return specifier.slice(11).replace(/^d\//, "");
	let url: URL;
	try {
		url = new URL(specifier);
	} catch {
		return null;
	}
	if (["observablehq.com", "new.observablehq.com"].includes(url.hostname) && url.pathname.startsWith("/api/import/"))
		return url.pathname.slice("/api/import/".length).replace(/^d\//, "");
	if (url.hostname !== "api.observablehq.com" || !url.pathname.endsWith(".js")) return null;
	return url.pathname.slice(1, -3).replace(/^d\//, "");
}

export function resolveRuntimeImport(specifier: string): string {
	const reference = notebookReference(specifier);
	return reference === null ? resolveImportDefault(specifier) : `${RUNTIME_NOTEBOOK_PROTOCOL}${reference}`;
}

export function bindNotebookImports(source: string, load: ImportModule | undefined) {
	let name = "__notebookImport";
	while (source.includes(name)) name += "_";
	const edits: { start: number; end: number; value: string }[] = [];
	simple(parseJavaScript(source).body, {
		ImportExpression(node) {
			if (node.source.type !== "Literal" || !isString(node.source.value)) return;
			const reference = notebookReference(node.source.value);
			if (reference !== null)
				edits.push({ start: node.start, end: node.end, value: `${name}(${JSON.stringify(reference)})` });
		},
	});
	for (const edit of edits.sort((a, b) => b.start - a.start))
		source = source.slice(0, edit.start) + edit.value + source.slice(edit.end);
	return {
		source,
		name,
		load:
			load ??
			(async (specifier: string) => {
				throw new Error(`Notebook import ${specifier} requires a resolveNotebook source loader`);
			}),
	};
}

export function resolveNotebookReference(reference: string, origin?: NotebookOrigin): string {
	if (/(?:@(?:\d+|latest)|~\d+)$/.test(reference)) return reference;
	const resolutions = origin?.resolutions;
	return resolutions && Object.prototype.hasOwnProperty.call(resolutions, reference)
		? resolutions[reference]!
		: reference;
}

export function notebookSourceUrl(reference: string): string {
	return `https://observablehq.com/${reference.startsWith("@") ? reference : `d/${reference.replace(/^d\//, "")}`}`;
}
