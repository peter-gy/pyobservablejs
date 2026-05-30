import { library } from "@observablehq/notebook-kit/runtime";

export type MarkdownRenderer = Awaited<ReturnType<(typeof library)["md"]>>;

type MarkdownFence = {
	character: string;
	length: number;
};

type MarkdownCall = {
	template: readonly string[];
	values: unknown[];
};

const markdownRenderers = new WeakMap<MarkdownRenderer, MarkdownRenderer>();
const markdownValueMarker = (index: number) => `\uE000pyobservablejs-md:${index}\uE001`;
const markdownValueMarkerPattern = /\uE000pyobservablejs-md:(\d+)\uE001/g;

function normalizeMarkdownCall(template: readonly string[], values: unknown[]): MarkdownCall {
	const valueMarkers: unknown[] = [];
	const source = stitchMarkdownSource(template, values, valueMarkers);
	const normalized = normalizeObservableMarkdown(source);
	if (normalized === source) return { template, values };
	return splitMarkdownSource(normalized, valueMarkers);
}

function stitchMarkdownSource(template: readonly string[], values: unknown[], valueMarkers: unknown[]): string {
	let source = template[0] ?? "";
	for (let index = 0; index < values.length; index++) {
		source += markdownValueSource(values[index], valueMarkers);
		source += template[index + 1] ?? "";
	}
	return source;
}

function markdownValueSource(value: unknown, valueMarkers: unknown[]): string {
	if (isNode(value)) return markdownNodeMarker(value, valueMarkers);
	if (!Array.isArray(value)) return markdownText(value);
	let source = "";
	let nodes: Node[] | null = null;
	for (const item of value) {
		if (isNode(item)) {
			if (!nodes) {
				nodes = [];
				source += markdownNodeMarker(nodes, valueMarkers);
			}
			nodes.push(item);
		} else {
			nodes = null;
			source += markdownText(item);
		}
	}
	return source;
}

function markdownText(value: unknown): string {
	return "" + (value as string);
}

function markdownNodeMarker(value: unknown, valueMarkers: unknown[]): string {
	const index = valueMarkers.length;
	valueMarkers.push(value);
	return markdownValueMarker(index);
}

function splitMarkdownSource(source: string, valueMarkers: unknown[]): MarkdownCall {
	const template: string[] = [];
	const values: unknown[] = [];
	let cursor = 0;
	for (const match of source.matchAll(markdownValueMarkerPattern)) {
		template.push(source.slice(cursor, match.index));
		values.push(valueMarkers[Number(match[1])]);
		cursor = match.index + match[0].length;
	}
	template.push(source.slice(cursor));
	return { template, values };
}

function isNode(value: unknown): value is Node {
	return typeof Node !== "undefined" && value instanceof Node;
}

function normalizeObservableMarkdown(source: string): string {
	const state: { fence: MarkdownFence | null } = { fence: null };
	const parts = source.split(/(\r\n|\n|\r)/);
	for (let index = 0; index < parts.length; index += 2) {
		const line = parts[index];
		if (line === undefined) continue;
		const marker = markdownFenceMarker(line);
		if (marker) {
			if (state.fence) {
				if (closesMarkdownFence(marker, state.fence)) state.fence = null;
			} else {
				state.fence = marker;
			}
		}
		if (!state.fence && !marker && !isIndentedMarkdownCode(line)) parts[index] = normalizeMarkdownStrongLine(line);
	}
	return parts.join("");
}

function markdownFenceMarker(line: string): MarkdownFence | null {
	const marker = /^[ \t]{0,3}(?:(?:>[ \t]*)+)?(`{3,}|~{3,})/.exec(line)?.[1];
	return marker ? { character: marker[0] ?? "", length: marker.length } : null;
}

function closesMarkdownFence(marker: MarkdownFence, fence: MarkdownFence): boolean {
	return marker.character === fence.character && marker.length >= fence.length;
}

function isIndentedMarkdownCode(line: string): boolean {
	return /^(?: {4,}|\t)/.test(line);
}

function normalizeMarkdownStrongLine(line: string): string {
	return line
		.replace(/^([ \t]*(?:(?:>[ \t]*)+)?(?:(?:[-+*]|\d+[.)])[ \t]+)?\*\*)[ \t]+(?=\S)/, "$1")
		.replace(/(\S)[ \t]+(\*\*)[ \t]*$/, "$1$2");
}

export function normalizeMarkdownRenderer(render: MarkdownRenderer): MarkdownRenderer {
	const existing = markdownRenderers.get(render);
	if (existing) return existing;
	const normalized = ((template: readonly string[], ...values: unknown[]) => {
		const normalized = normalizeMarkdownCall(template, values);
		return render(normalized.template, ...normalized.values);
	}) as MarkdownRenderer;
	markdownRenderers.set(render, normalized);
	return normalized;
}
