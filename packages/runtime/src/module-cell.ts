import { library } from "@observablehq/notebook-kit/runtime";
import type { Definition } from "@observablehq/notebook-kit/runtime";
import type { Module, RuntimeRecord } from "@observablehq/runtime";
import { Library } from "@observablehq/stdlib";

const generatedIds = new WeakMap<Module, number>();

export function nextModuleCellId(module: Module): number {
	const id = (generatedIds.get(module) ?? 0) - 1;
	generatedIds.set(module, id);
	return id;
}

// NotebookRuntime.define eagerly observes plural outputs. Imports need lazy
// variables and the remote "viewof name" / "mutable name" bindings instead.
export function defineModuleCell(module: Module, definition: Definition): void {
	const { id, body, inputs = [], outputs = [], output } = definition;
	if (definition.autoview && output) {
		const name = unprefix(output, "viewof$");
		const view = `viewof ${name}`;
		module.define(view, inputs, body);
		module.import(view, output, module);
		module.define(name, [view], library.Generators().input);
		return;
	}
	if (definition.automutable && output) {
		const name = unprefix(output, "mutable ");
		const initial = `initial ${name}`;
		const Mutable = new Library().Mutable();
		module.define(initial, inputs, body);
		module.define(output, [initial], (value) => new Mutable(value));
		module.import(output, `mutable$${name}`, module);
		module.define(name, [output], (value) => value.generator);
		return;
	}
	if (output) {
		module.define(output, inputs, body);
		return;
	}
	const cell = `cell ${id}`;
	module.define(cell, inputs, body);
	for (const name of outputs) module.define(name, [cell], (exports: RuntimeRecord) => exports[name]);
}

function unprefix(name: string, prefix: string): string {
	if (!name.startsWith(prefix)) throw new Error(`Expected ${prefix} output`);
	return name.slice(prefix.length);
}
