declare module "@observablehq/parser" {
	type Reference = {
		name: string;
	};

	type ParsedCell = {
		references: Reference[];
		body: import("acorn").Node | null;
	};

	export function parseCell(source: string): ParsedCell;
	export function parseCell(
		source: string,
		options: { tag: string; raw?: boolean },
	): ParsedCell & { body: import("acorn").TemplateLiteral | null };
}
