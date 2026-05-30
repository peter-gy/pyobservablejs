import { transpile, type Cell, type Notebook } from "@observablehq/notebook-kit";
import { observe, type NotebookRuntime } from "@observablehq/notebook-kit/runtime";
import { exposedVariableNames, unprefix } from "../observable/graph";
import { createRuntimeDefinition } from "../runtime/definition";
import { toWireValue } from "../runtime/wire";
import { applyModelVariablesToViews, registerView } from "./cell-value-sync";
import { createCellOutput, createTopLevelError } from "./dom";
import { renderSource } from "./highlight";
import type { CellVariableSync, RuntimeObserver } from "./types";

type RenderCellOptions = {
	wrapper: HTMLElement;
	runtime: NotebookRuntime;
	cell: Cell;
	showSource: boolean;
	sync?: CellVariableSync;
	signal: AbortSignal;
	cellName?: string;
};

/**
 * Render one Notebook Kit cell into a widget-owned wrapper.
 */
export function renderCell({ wrapper, runtime, cell, showSource, sync, signal, cellName }: RenderCellOptions): void {
	wrapper.replaceChildren();
	const output = createCellOutput(wrapper, cell);
	defineCell(runtime, output, cell, sync, cellName);

	if (showSource && cell.pinned) {
		wrapper.appendChild(renderSource(cell, signal));
	}
}

/**
 * Define a cell in an Observable runtime and wire exposed values to the sync adapter.
 */
export function defineCell(
	runtime: NotebookRuntime,
	root: HTMLDivElement,
	cell: Cell,
	sync?: CellVariableSync,
	cellName?: string,
): void {
	try {
		const definition = transpile(cell, { resolveLocalImports: true });
		const exposed = exposedVariableNames(definition);
		const displayName = exposed.length === 0 && cellName ? cellName : null;
		sync?.setVariableNames(displayName ? [displayName] : exposed);
		runtime.define(
			{
				root,
				expanded: [],
				variables: [],
			},
			createRuntimeDefinition(cell, definition),
			sync ? createCellObserver(sync, definition, displayName) : observe,
		);
		for (const name of exposed) {
			if (sync) runtime.main.variable(createSyncObserver(sync, name)).define([name], (value: unknown) => value);
		}
		if (sync) applyModelVariablesToViews(sync);
	} catch (error) {
		root.appendChild(createTopLevelError(error));
	}
}

export function renderCellError(wrapper: HTMLElement, error: unknown): void {
	wrapper.replaceChildren(createTopLevelError(error));
}

/**
 * Return every `viewof` name that should receive Python variable updates.
 */
export function notebookViewNames(notebook: Notebook): Set<string> {
	const names = new Set<string>();
	for (const cell of notebook.cells) {
		try {
			const name = viewVariableName(transpile(cell, { resolveLocalImports: true }));
			if (name) names.add(name);
		} catch {
			continue;
		}
	}
	return names;
}

function createCellObserver(
	sync: CellVariableSync,
	definition: ReturnType<typeof transpile>,
	displayName: string | null,
): typeof observe {
	return (state, runtimeDefinition) => {
		const observer = observe(state, runtimeDefinition);
		const fulfilled = observer.fulfilled.bind(observer);
		observer.fulfilled = (value: unknown) => {
			const viewName = viewVariableName(definition);
			if (viewName) registerView(sync, viewName, value);
			if (displayName) sync.setVariable(displayName, toWireValue(value));
			fulfilled(value);
		};
		return observer;
	};
}

function createSyncObserver(sync: CellVariableSync, name: string): RuntimeObserver {
	return {
		pending() {},
		fulfilled(value: unknown) {
			sync.setVariable(name, toWireValue(value));
		},
		rejected(error: unknown) {
			sync.setVariable(name, toWireValue(error));
		},
	};
}

function viewVariableName(definition: ReturnType<typeof transpile>): string | null {
	if (!definition.autoview || !definition.output) return null;
	return unprefix(definition.output, "viewof$");
}
