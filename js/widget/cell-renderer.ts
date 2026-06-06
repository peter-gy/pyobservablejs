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
	pythonVariableNames?: Set<string>;
};
type RuntimeDefinition = Parameters<NotebookRuntime["define"]>[1];

/**
 * Render one Notebook Kit cell into a widget-owned wrapper.
 */
export function renderCell({
	wrapper,
	runtime,
	cell,
	showSource,
	sync,
	signal,
	cellName,
	pythonVariableNames,
}: RenderCellOptions): void {
	wrapper.replaceChildren();
	const output = createCellOutput(wrapper, cell);
	defineCell(runtime, output, cell, sync, cellName, pythonVariableNames);

	if (showSource && cell.pinned) {
		appendSource(wrapper, cell, signal);
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
	pythonVariableNames: Set<string> = new Set(),
): void {
	try {
		const definition = transpile(cell, { resolveLocalImports: true });
		const exposed = exposedVariableNames(definition);
		const displayName = exposed.length === 0 && cellName ? cellName : null;
		const pythonNames = pythonOwnedNames(definition, exposed, pythonVariableNames);
		sync?.setVariableNames(displayName ? [displayName] : exposed);
		if (sync && pythonNames.length === exposed.length && pythonNames.length > 0) {
			renderPythonVariableCell(runtime, root, cell, definition, pythonNames);
			defineSyncObservers(runtime, sync, exposed);
			applyModelVariablesToViews(sync);
			return;
		}
		const sourceDefinition = sourceRuntimeDefinition(definition, pythonNames);
		runtime.define(
			{
				root,
				expanded: [],
				variables: [],
			},
			createRuntimeDefinition(cell, sourceDefinition),
			sync ? createCellObserver(sync, sourceDefinition, displayName) : observe,
		);
		if (sync) defineSyncObservers(runtime, sync, exposed);
		if (sync) applyModelVariablesToViews(sync);
	} catch (error) {
		root.appendChild(createTopLevelError(error));
	}
}

export function renderCellError(wrapper: HTMLElement, error: unknown): void {
	wrapper.replaceChildren(createTopLevelError(error));
}

function appendSource(wrapper: HTMLElement, cell: Cell, signal: AbortSignal): void {
	try {
		if (!signal.aborted) wrapper.appendChild(renderSource(cell, signal));
	} catch (error) {
		if (!signal.aborted) wrapper.appendChild(createTopLevelError(error));
	}
}

function renderPythonVariableCell(
	runtime: NotebookRuntime,
	root: HTMLDivElement,
	cell: Cell,
	sourceDefinition: ReturnType<typeof transpile>,
	names: string[],
): void {
	const definition: RuntimeDefinition = {
		id: cell.id,
		body: (...values: unknown[]) =>
			names.length === 1 ? values[0] : Object.fromEntries(names.map((name, index) => [name, values[index]])),
		inputs: names,
		outputs: [],
		output: undefined,
		autodisplay: sourceDefinition.autodisplay,
		autoview: false,
		automutable: false,
	};
	runtime.define(
		{
			root,
			expanded: [],
			variables: [],
		},
		definition,
		observe,
	);
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
		const rejected = observer.rejected.bind(observer);
		observer.rejected = (error: unknown) => {
			if (displayName) sync.setVariable(displayName, toWireValue(error));
			rejected(error);
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

function defineSyncObservers(runtime: NotebookRuntime, sync: CellVariableSync, names: string[]): void {
	for (const name of names) {
		runtime.main.variable(createSyncObserver(sync, name)).define([name], (value: unknown) => value);
	}
}

function pythonOwnedNames(
	definition: ReturnType<typeof transpile>,
	exposed: string[],
	pythonVariableNames: Set<string>,
): string[] {
	if (definition.autoview || definition.automutable) return [];
	return exposed.filter((name) => pythonVariableNames.has(name));
}

function sourceRuntimeDefinition(
	definition: ReturnType<typeof transpile>,
	pythonNames: readonly string[],
): ReturnType<typeof transpile> {
	if (!definition.outputs || pythonNames.length === 0) return definition;
	const pythonNameSet = new Set(pythonNames);
	return {
		...definition,
		outputs: definition.outputs.filter((name) => !pythonNameSet.has(name)),
	};
}

function viewVariableName(definition: ReturnType<typeof transpile>): string | null {
	if (!definition.autoview || !definition.output) return null;
	return unprefix(definition.output, "viewof$");
}
