declare module "@observablehq/parser" {
	type Reference = {
		name: string;
	};

	type ParsedCell = {
		references: Reference[];
		body: import("acorn").Node | null;
	};

	export function parseCell(source: string): ParsedCell;
}
