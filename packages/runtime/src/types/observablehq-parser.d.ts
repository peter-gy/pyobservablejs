declare module "@observablehq/parser" {
	type Reference = {
		name: string;
	};

	type ParsedCell = {
		references: Reference[];
	};

	export function parseCell(source: string): ParsedCell;
}
