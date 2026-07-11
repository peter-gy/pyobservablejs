import type { Cell } from "@observablehq/notebook-kit";
import { observe, type DisplayState, type NotebookRuntime } from "@observablehq/notebook-kit/runtime";
import {
	defineCompiledRuntimeCell,
	defineRuntimeCell,
	exposedVariableNames,
	isViewTarget,
	observeRuntimeVariable,
	runtimeDocument,
	toWireValue,
	transpileNotebookCell,
	viewVariableName,
	type CellAnalysis,
	type NotebookAnalysis,
	type NotebookOptions,
	type RuntimeCellDefinition,
	type RuntimeVariablesSync,
} from "@pyobservablejs/runtime";
import { createCellOutput, createTopLevelError, renderSource } from "./dom";
import type { CellVariableSync, RuntimeViewSync } from "./variable-sync";

type RuntimeDefinition = Parameters<NotebookRuntime["define"]>[1];
type RuntimeObserver = Parameters<NotebookRuntime["main"]["variable"]>[0];
type DisplayObserver = ReturnType<typeof observe>;
type DefinitionInput = { definition: RuntimeCellDefinition } | { error: unknown };

export type CellRenderTarget = {
	index: number;
	wrapper: HTMLElement;
	cell: Cell;
	showSource: boolean;
	visible: boolean;
	sync?: CellVariableSync;
	variablesSync?: RuntimeVariablesSync;
	cellName?: string;
};

export type CellRenderContext = {
	runtime: NotebookRuntime;
	signal: AbortSignal;
	pythonVariableNames: Set<string>;
	analysis: NotebookAnalysis;
	notebookNames: ReadonlySet<string>;
	runtimeCompatibility: NotebookOptions["runtimeCompatibility"];
	viewSync: RuntimeViewSync;
};

export function renderCellTargets(targets: readonly CellRenderTarget[], context: CellRenderContext): void {
	for (const target of targets) renderCellTarget(target, context);
}

export function renderCellTarget(target: CellRenderTarget, context: CellRenderContext): void {
	renderCell({
		wrapper: target.wrapper,
		runtime: context.runtime,
		cell: target.cell,
		showSource: target.visible && target.showSource,
		visible: target.visible,
		sync: target.sync,
		variablesSync: target.variablesSync,
		viewSync: context.viewSync,
		signal: context.signal,
		cellName: target.cellName,
		pythonVariableNames: context.pythonVariableNames,
		analysis: context.analysis.cells[target.index],
		notebookNames: context.notebookNames,
		runtimeCompatibility: context.runtimeCompatibility,
	});
}

function renderCell({
	wrapper,
	runtime,
	cell,
	showSource,
	visible,
	sync,
	variablesSync,
	viewSync,
	signal,
	cellName,
	pythonVariableNames = new Set(),
	analysis,
	notebookNames,
	runtimeCompatibility,
}: {
	wrapper: HTMLElement;
	runtime: NotebookRuntime;
	cell: Cell;
	showSource: boolean;
	visible: boolean;
	sync?: CellVariableSync;
	variablesSync?: RuntimeVariablesSync;
	viewSync: RuntimeViewSync;
	signal: AbortSignal;
	cellName?: string;
	pythonVariableNames?: Set<string>;
	analysis?: CellAnalysis;
	notebookNames?: ReadonlySet<string>;
	runtimeCompatibility?: NotebookOptions["runtimeCompatibility"];
}): void {
	wrapper.replaceChildren();
	const output = createCellOutput(wrapper, cell);
	defineCell(
		runtime,
		output,
		cell,
		sync,
		variablesSync,
		viewSync,
		cellName,
		pythonVariableNames,
		definitionInputFromAnalysis(analysis),
		notebookNames,
		runtimeCompatibility,
		visible,
	);
	if (showSource && cell.pinned) appendSource(wrapper, cell, signal);
}

function defineCell(
	runtime: NotebookRuntime,
	root: HTMLDivElement,
	cell: Cell,
	sync: CellVariableSync | undefined,
	variablesSync: RuntimeVariablesSync | undefined,
	viewSync: RuntimeViewSync,
	cellName?: string,
	pythonVariableNames: Set<string> = new Set(),
	definitionInput?: DefinitionInput,
	notebookNames?: ReadonlySet<string>,
	runtimeCompatibility?: NotebookOptions["runtimeCompatibility"],
	visible = true,
): void {
	try {
		const definition = readDefinition(cell, definitionInput);
		const exposed = exposedVariableNames(definition);
		const displayName = exposed.length === 0 && cellName ? cellName : null;
		const pythonNames = pythonOwnedNames(definition, exposed, pythonVariableNames);
		sync?.setVariableNames(displayName ? [displayName] : exposed);
		const observer = visible ? safeObserve : observeWithoutVisibilityNode;
		if (pythonNames.length === exposed.length && pythonNames.length > 0) {
			renderPythonVariableCell(runtime, root, cell, definition, pythonNames, observer);
			if (sync) defineSyncObservers(runtime, sync, exposed);
			return;
		}
		const sourceDefinition = sourceRuntimeDefinition(definition, pythonNames);
		defineRuntimeCell(
			runtime,
			root,
			cell,
			sourceDefinition,
			sync
				? createCellObserver(sync, viewSync, sourceDefinition, displayName, exposed.length > 0)
				: createRuntimeInputObserver(observer, variablesSync, viewSync, sourceDefinition),
			{
				document: runtimeDocument(runtime),
				notebookNames,
				runtimeCompatibility,
			},
		);
		if (sync) defineSyncObservers(runtime, sync, exposed);
	} catch (error) {
		root.appendChild(createTopLevelError(error));
		sync?.markRendered();
	}
}

function createRuntimeInputObserver(
	observer: typeof observe,
	variablesSync: RuntimeVariablesSync | undefined,
	viewSync: RuntimeViewSync,
	definition: RuntimeCellDefinition,
): typeof observe {
	const viewName = viewVariableName(definition);
	if (!variablesSync || !viewName) return observer;
	return (state, runtimeDefinition) => {
		const runtimeObserver = observer(state, runtimeDefinition);
		const fulfilled = runtimeObserver.fulfilled.bind(runtimeObserver);
		runtimeObserver.fulfilled = (value: unknown) => {
			if (isViewTarget(value)) viewSync.register(viewName, value);
			fulfilled(value);
		};
		return runtimeObserver;
	};
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
	sourceDefinition: RuntimeCellDefinition,
	names: string[],
	observer: typeof observe,
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
	defineCompiledRuntimeCell(runtime, root, definition, observer);
}

function definitionInputFromAnalysis(analysis: CellAnalysis | undefined): DefinitionInput | undefined {
	if (!analysis) return undefined;
	if (analysis.definition) return { definition: analysis.definition };
	return { error: analysis.error };
}

function readDefinition(cell: Cell, input: DefinitionInput | undefined): RuntimeCellDefinition {
	if (!input) return transpileNotebookCell(cell);
	if ("definition" in input) return input.definition;
	throw input.error;
}

function createCellObserver(
	sync: CellVariableSync,
	viewSync: RuntimeViewSync,
	definition: RuntimeCellDefinition,
	displayName: string | null,
	hasSyncedNames: boolean,
): typeof observe {
	const displayObserverCompletesReadback = displayName !== null || !hasSyncedNames;
	return (state, runtimeDefinition) => {
		// Keep the runtime output for variable wiring and clear the display label so
		// Selected cell output renders the value text expected by Python callers.
		const observer = safeObserve(state, { ...runtimeDefinition, output: undefined });
		const fulfilled = observer.fulfilled.bind(observer);
		observer.fulfilled = (value: unknown) => {
			const viewName = viewVariableName(definition);
			if (viewName) viewSync.register(viewName, value);
			if (displayName) sync.setVariable(displayName, toWireValue(value));
			if (displayObserverCompletesReadback) sync.markRendered();
			fulfilled(value);
		};
		const rejected = observer.rejected.bind(observer);
		observer.rejected = (error: unknown) => {
			if (displayName) sync.setVariable(displayName, toWireValue(error));
			if (displayObserverCompletesReadback) sync.markRendered();
			rejected(error);
		};
		return observer;
	};
}

function safeObserve(state: DisplayState, definition: RuntimeDefinition): DisplayObserver {
	const observer = observe(state, definition) as DisplayObserver;
	const fulfilled = observer.fulfilled.bind(observer);
	const rejected = observer.rejected.bind(observer);
	return {
		...observer,
		pending: observer.pending.bind(observer),
		fulfilled(value: unknown) {
			renderSafely(state, () => fulfilled(value));
		},
		rejected(error: unknown) {
			renderSafely(state, () => rejected(error));
		},
	};
}

function observeWithoutVisibilityNode(state: DisplayState, definition: RuntimeDefinition): DisplayObserver {
	const observer = safeObserve(state, definition);
	Reflect.deleteProperty(observer, "_node");
	return observer;
}

function renderSafely(state: DisplayState, render: () => void): void {
	try {
		render();
	} catch (error) {
		state.root.replaceChildren(createInspectFallback(state.root.ownerDocument, error));
	}
}

function createInspectFallback(document: Document, error: unknown): HTMLDivElement {
	const node = document.createElement("div");
	node.className = "observablehq";
	const value = node.appendChild(document.createElement("span"));
	value.className = "observablehq--inspect";
	value.textContent = `Unable to inspect value: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
	return node;
}

function createSyncObserver(sync: CellVariableSync, name: string, onSettled: () => void): RuntimeObserver {
	let settled = false;
	const settle = () => {
		if (settled) return;
		settled = true;
		onSettled();
	};
	return {
		pending() {},
		fulfilled(value: unknown) {
			sync.setVariable(name, toWireValue(value));
			settle();
		},
		rejected(error: unknown) {
			sync.setVariable(name, toWireValue(error));
			settle();
		},
	};
}

function defineSyncObservers(runtime: NotebookRuntime, sync: CellVariableSync, names: string[]): void {
	const pending = new Set(names);
	const settle = (name: string) => {
		pending.delete(name);
		if (pending.size === 0) sync.markRendered();
	};
	for (const name of names) {
		observeRuntimeVariable(
			runtime,
			name,
			createSyncObserver(sync, name, () => settle(name)),
		);
	}
}

function pythonOwnedNames(
	definition: RuntimeCellDefinition,
	exposed: string[],
	pythonVariableNames: Set<string>,
): string[] {
	if (definition.autoview || definition.automutable) return [];
	return exposed.filter((name) => pythonVariableNames.has(name));
}

function sourceRuntimeDefinition(
	definition: RuntimeCellDefinition,
	pythonNames: readonly string[],
): RuntimeCellDefinition {
	if (!definition.outputs || pythonNames.length === 0) return definition;
	const pythonNameSet = new Set(pythonNames);
	return {
		...definition,
		outputs: definition.outputs.filter((name) => !pythonNameSet.has(name)),
	};
}
