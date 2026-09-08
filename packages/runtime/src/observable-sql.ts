import { transpile, transpileTemplate, type Cell } from "@observablehq/notebook-kit";
import type { RuntimeCellDefinition } from "./definition";

export function transpileObservableSql(cell: Cell): RuntimeCellDefinition {
	if (!cell.value) return transpile(cell, { resolveLocalImports: true });
	const database = cell.database ?? "var:db";
	const source = database.startsWith("var:")
		? database.slice(4)
		: `DatabaseClient(${JSON.stringify(database)}, ${JSON.stringify({ id: cell.id, since: cell.since })})`;
	const query = transpileTemplate(
		cell.value,
		`__query.sql(${source}, invalidation, ${JSON.stringify(database.startsWith("var:") ? source : database)})`,
		true,
	);
	const used = new Set(transpile({ ...cell, mode: "ojs", value: query }, { resolveLocalImports: true }).inputs);
	if (cell.output) used.add(cell.output);
	const fresh = (name: string) => {
		while (used.has(name)) name += "_";
		used.add(name);
		return name;
	};
	const result = fresh("_sqlResult");
	const rows = fresh("_sqlRows");
	const element = fresh("_sqlElement");
	const root = fresh("_sqlRoot");
	const value = `${cell.output ? `${cell.output} = ` : ""}{
${cell.hidden ? "" : `const ${element} = document.createElement("div"); ${root}.replaceChildren(${element});`}
const ${result} = await (${query});
for await (const ${rows} of Array.isArray(${result}) ? [${result}] : ${result}) {
${cell.hidden ? "" : `${element}.replaceChildren(Inputs.table(${rows}));`}
yield ${rows};
}
}`;
	const definition = transpile({ ...cell, mode: "ojs", value }, { resolveLocalImports: true });
	return {
		...definition,
		inputs: definition.inputs?.filter((name) => name !== root),
		rootInput: cell.hidden ? undefined : definition.inputs?.indexOf(root),
		autodisplay: false,
		display: false,
	};
}
