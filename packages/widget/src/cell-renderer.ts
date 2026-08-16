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
	type RuntimeValue,
} from "@pyobservablejs/runtime";
import { createCellOutput, createTopLevelError, renderSource } from "./dom";
import type { CellVariableSync, RuntimeViewSync } from "./variable-sync";

type RuntimeDefinition = Parameters<NotebookRuntime["define"]>[1];
type RuntimeObserver = Parameters<NotebookRuntime["main"]["variable"]>[0];
type DisplayObserver = ReturnType<typeof observe>;
type ObservedValue = Parameters<DisplayObserver["fulfilled"]>[0];
type ObservedCause = Parameters<DisplayObserver["rejected"]>[0];
type DefinitionInput = { definition: RuntimeCellDefinition } | { error: unknown };

export type CellRenderTarget = {
	index: number;
	wrapper: HTMLElement;
	cell: Cell;
	showSource: boolean;
	visible: boolean;
	sync?: CellVariableSync;
	cellName?: string;
};

export type CellRenderContext = {
	runtime: NotebookRuntime;
	signal: AbortSignal;
	pythonVariableNames: Set<string>;
	analysis: NotebookAnalysis;
	notebookNames: ReadonlySet<string>;
	runtimeProfile: NotebookOptions["runtimeProfile"];
	viewSync: RuntimeViewSync;
};

export function renderCellTarget(target: CellRenderTarget, context: CellRenderContext): void {
	renderCell({
		wrapper: target.wrapper,
		runtime: context.runtime,
		cell: target.cell,
		showSource: target.visible && target.showSource,
		visible: target.visible,
		sync: target.sync,
		viewSync: context.viewSync,
		signal: context.signal,
		cellName: target.cellName,
		pythonVariableNames: context.pythonVariableNames,
		analysis: context.analysis.cells[target.index],
		notebookNames: context.notebookNames,
		runtimeProfile: context.runtimeProfile,
	});
}

function renderCell({
	wrapper,
	runtime,
	cell,
	showSource,
	visible,
	sync,
	viewSync,
	signal,
	cellName,
	pythonVariableNames = new Set(),
	analysis,
	notebookNames,
	runtimeProfile,
}: {
	wrapper: HTMLElement;
	runtime: NotebookRuntime;
	cell: Cell;
	showSource: boolean;
	visible: boolean;
	sync?: CellVariableSync;
	viewSync: RuntimeViewSync;
	signal: AbortSignal;
	cellName?: string;
	pythonVariableNames?: Set<string>;
	analysis?: CellAnalysis;
	notebookNames?: ReadonlySet<string>;
	runtimeProfile?: NotebookOptions["runtimeProfile"];
}): void {
	wrapper.replaceChildren();
	const output = createCellOutput(wrapper, cell);
	defineCell(
		runtime,
		output,
		cell,
		sync,
		viewSync,
		cellName,
		pythonVariableNames,
		definitionInputFromAnalysis(analysis),
		notebookNames,
		runtimeProfile,
		visible,
	);
	if (showSource && cell.pinned) appendSource(wrapper, cell, signal, sync);
}

function defineCell(
	runtime: NotebookRuntime,
	root: HTMLDivElement,
	cell: Cell,
	sync: CellVariableSync | undefined,
	viewSync: RuntimeViewSync,
	cellName?: string,
	pythonVariableNames: Set<string> = new Set(),
	definitionInput?: DefinitionInput,
	notebookNames?: ReadonlySet<string>,
	runtimeProfile?: NotebookOptions["runtimeProfile"],
	visible = true,
): void {
	try {
		const definition = readDefinition(cell, definitionInput);
		const exposed = exposedVariableNames(definition);
		const displayName = exposed.length === 0 && cellName ? cellName : null;
		const pythonNames = pythonOwnedNames(definition, exposed, pythonVariableNames);
		const observer = visible ? safeObserve : observeWithoutVisibilityNode;
		if (pythonNames.length === exposed.length && pythonNames.length > 0) {
			sync?.configure(exposed, false);
			renderPythonVariableCell(runtime, root, cell, definition, pythonNames, observer);
			if (sync) defineSyncObservers(runtime, sync, exposed);
			return;
		}
		sync?.configure(displayName ? [] : exposed, true);
		const sourceDefinition = sourceRuntimeDefinition(definition, pythonNames);
		defineRuntimeCell(
			runtime,
			root,
			cell,
			sourceDefinition,
			visible
				? createVisibleCellObserver(viewSync, sourceDefinition, displayName, sync)
				: createRuntimeInputObserver(observer, viewSync, sourceDefinition),
			{
				document: runtimeDocument(runtime),
				notebookNames,
				runtimeProfile,
			},
		);
		if (sync) defineSyncObservers(runtime, sync, exposed);
	} catch (error) {
		root.appendChild(createTopLevelError(error));
		sync?.fail(error, "analysis");
	}
}

function createRuntimeInputObserver(
	observer: typeof observe,
	viewSync: RuntimeViewSync,
	definition: RuntimeCellDefinition,
): typeof observe {
	const viewName = viewVariableName(definition);
	if (!viewName) return observer;
	return (state, runtimeDefinition) => {
		const runtimeObserver = observer(state, runtimeDefinition);
		const fulfilled = runtimeObserver.fulfilled.bind(runtimeObserver);
		runtimeObserver.fulfilled = (value: ObservedValue) => {
			if (isViewTarget(value)) viewSync.register(viewName, value);
			fulfilled(value);
		};
		return runtimeObserver;
	};
}

function appendSource(wrapper: HTMLElement, cell: Cell, signal: AbortSignal, sync?: CellVariableSync): void {
	try {
		if (!signal.aborted) wrapper.appendChild(renderSource(cell, signal));
	} catch (error) {
		if (!signal.aborted) wrapper.appendChild(createTopLevelError(error));
		sync?.fail(error, "rendering");
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
		body: (...values: RuntimeValue[]) =>
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

function createVisibleCellObserver(
	viewSync: RuntimeViewSync,
	definition: RuntimeCellDefinition,
	displayName: string | null,
	sync?: CellVariableSync,
): typeof observe {
	return (state, runtimeDefinition) => {
		let renderFailed = false;
		// Keep the runtime output for variable wiring and clear the display label so
		// Selected cell output renders the value text expected by Python callers.
		const observer = safeObserve(state, { ...runtimeDefinition, output: undefined }, (error) => {
			renderFailed = true;
			sync?.rejected("display", error, "rendering", displayName ?? undefined);
		});
		const pending = observer.pending.bind(observer);
		observer.pending = () => {
			renderFailed = false;
			sync?.pending("display");
			pending();
		};
		const fulfilled = observer.fulfilled.bind(observer);
		observer.fulfilled = (value: ObservedValue) => {
			const viewName = viewVariableName(definition);
			if (viewName) viewSync.register(viewName, value);
			fulfilled(value);
			if (renderFailed || !sync) return;
			if (!displayName) {
				sync.fulfilled("display");
				return;
			}
			try {
				sync.fulfilled("display", displayName, toWireValue(value));
			} catch (error) {
				sync.rejected("display", error, "serialization", displayName);
			}
		};
		const rejected = observer.rejected.bind(observer);
		observer.rejected = (cause: ObservedCause) => {
			rejected(cause);
			if (!renderFailed && sync) {
				sync.rejected("display", cause, "evaluation", displayName ?? undefined);
			}
		};
		return observer;
	};
}

function safeObserve(
	state: DisplayState,
	definition: RuntimeDefinition,
	onRenderError?: (cause: ObservedCause) => void,
): DisplayObserver {
	const observer = observe(state, definition);
	const fulfilled = observer.fulfilled.bind(observer);
	const rejected = observer.rejected.bind(observer);
	return {
		...observer,
		pending: observer.pending.bind(observer),
		fulfilled(value: ObservedValue) {
			renderSafely(state, () => fulfilled(value), onRenderError);
		},
		rejected(cause: ObservedCause) {
			renderSafely(state, () => rejected(cause), onRenderError);
		},
	};
}

function observeWithoutVisibilityNode(state: DisplayState, definition: RuntimeDefinition): DisplayObserver {
	const observer = safeObserve(state, definition);
	Reflect.deleteProperty(observer, "_node");
	return observer;
}

function renderSafely(state: DisplayState, render: () => void, onError?: (cause: ObservedCause) => void): void {
	try {
		render();
	} catch (error) {
		state.root.replaceChildren(createInspectFallback(state.root.ownerDocument, error));
		onError?.(error);
	}
}

function createInspectFallback(document: Document, cause: ObservedCause): HTMLDivElement {
	const node = document.createElement("div");
	node.className = "observablehq";
	const value = node.appendChild(document.createElement("span"));
	value.className = "observablehq--inspect";
	value.textContent = `Unable to inspect value: ${cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)}`;
	return node;
}

function createSyncObserver(sync: CellVariableSync, name: string): RuntimeObserver {
	const channel = `variable:${name}`;
	return {
		pending() {
			sync.pending(channel);
		},
		fulfilled(value: ObservedValue) {
			try {
				sync.fulfilled(channel, name, toWireValue(value));
			} catch (error) {
				sync.rejected(channel, error, "serialization", name);
			}
		},
		rejected(cause: ObservedCause) {
			sync.rejected(channel, cause, "evaluation", name);
		},
	};
}

function defineSyncObservers(runtime: NotebookRuntime, sync: CellVariableSync, names: string[]): void {
	for (const name of names) {
		observeRuntimeVariable(runtime, name, createSyncObserver(sync, name));
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
