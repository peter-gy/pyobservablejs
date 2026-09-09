import { transpileTemplate, type Cell } from "@observablehq/notebook-kit";
import { parseCell } from "@observablehq/parser";

export function observableTemplateCell(cell: Cell): Cell {
	if (!cell.value || !["html", "md", "tex", "dot"].includes(cell.mode)) return cell;
	const tag = cell.mode === "tex" ? "tex.block" : cell.mode;
	const template = parseCell(cell.value, { tag }).body;
	if (!template) return cell;
	let value = `${tag}\``;
	for (const [index, quasi] of template.quasis.entries()) {
		// Notebook Kit escapes literal text while Observable's parser preserves
		// viewof, mutable, and yield expressions inside interpolation boundaries.
		value += transpileTemplate(cell.value.slice(quasi.start, quasi.end), "", cell.mode !== "md").slice(1, -1);
		const expression = template.expressions[index];
		if (expression) value += `\${${cell.value.slice(expression.start, expression.end)}}`;
	}
	value += "`";
	return { ...cell, mode: "ojs", value: cell.output ? `${cell.output} = ${value}` : value };
}
