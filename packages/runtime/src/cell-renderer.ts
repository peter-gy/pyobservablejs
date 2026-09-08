import type { Cell } from "@observablehq/notebook-kit";
import {
	observe,
	type Definition as RuntimeDefinition,
	type DisplayState,
	type NotebookRuntime,
} from "@observablehq/notebook-kit/runtime";
import { defineCompiledRuntimeCell, defineRuntimeCell, observeRuntimeVariable } from "./execution";
import { exposedVariableNames, runtimeOutputNames, viewVariableName, type RuntimeCellDefinition } from "./definition";
import { isViewTarget } from "./views";
import { runtimeDocument } from "./scope";
import type { NotebookAnalysis } from "./graph";
import type { NotebookOptions } from "./environment";
import type { RuntimeValue } from "./values";
import { createCellOutput, createTopLevelError, renderSource } from "./dom";
import type { CellVariableSync } from "./cell-state";
import type { RuntimeViewSync } from "./view-inputs";
import type { NotebookValues } from "./notebook-values";
import {
	createDiagnostic,
	DiagnosticError,
	errorDetails,
	type DiagnosticCollector,
	type Diagnostic,
	type DiagnosticOrigin,
	type DiagnosticPhase,
} from "./diagnostics";

type RuntimeObserver = Parameters<NotebookRuntime["main"]["variable"]>[0];
type DisplayObserver = ReturnType<typeof observe>;
type ObservedValue = Parameters<DisplayObserver["fulfilled"]>[0];
type ObservedCause = Parameters<DisplayObserver["rejected"]>[0];

export type CellRenderTarget = {
	index: number;
	key: string;
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
	variableNames: Set<string>;
	analysis: NotebookAnalysis;
	notebookNames: ReadonlySet<string>;
	runtimeProfile: NotebookOptions["runtimeProfile"];
	viewSync: RuntimeViewSync;
	values: NotebookValues;
	diagnostics: DiagnosticCollector;
};

export function renderCellTarget(target: CellRenderTarget, context: CellRenderContext): void {
	const { wrapper, cell } = target;
	wrapper.replaceChildren();
	defineCell(target, context, createCellOutput(wrapper, cell));
	if (target.visible && target.showSource && cell.pinned) appendSource(target, context);
}

function defineCell(target: CellRenderTarget, context: CellRenderContext, root: HTMLDivElement): void {
	const { cell, sync, cellName, visible } = target;
	const { runtime, viewSync, variableNames, notebookNames, runtimeProfile } = context;
	try {
		const analysis = context.analysis.cells[target.index];
		if (!analysis) throw new Error(`Missing analysis for notebook cell ${target.index}`);
		if (!analysis.definition) {
			const diagnostic = reportCell(
				target,
				context,
				analysis.error,
				errorDetails(analysis.error).name === "SyntaxError" ? "notebook" : "runtime",
				"analysis",
				"packages/runtime/src/graph.ts",
				"analyze cell",
				"analysis",
			);
			context.values.fail(target.index, analysis.error, diagnostic);
			root.appendChild(createTopLevelError(analysis.error, root.ownerDocument));
			sync?.fail(analysis.error, "analysis");
			return;
		}
		const definition = analysis.definition;
		const exposed = exposedVariableNames(definition);
		const displayName = exposed.length === 0 && cellName ? cellName : null;
		const ownedNames = hostOwnedNames(definition, exposed, variableNames);
		const renderError = (cause: ObservedCause) =>
			reportCell(
				target,
				context,
				cause,
				"runtime",
				"rendering",
				"packages/runtime/src/cell-renderer.ts",
				"render cell",
				"rendering",
			);
		const observer: typeof observe = (state, definition) => {
			const result = safeObserve(state, definition, renderError);
			if (!visible) Reflect.deleteProperty(result, "_node");
			return result;
		};
		if (ownedNames.length === exposed.length && ownedNames.length > 0) {
			sync?.configure(exposed, false);
			renderVariableCell(runtime, root, cell, definition, ownedNames, observeDiagnostics(observer, target, context));
			defineSyncObservers(
				runtime,
				sync,
				exposed,
				context.values,
				target.index,
				runtimeOutputNames(definition),
				target,
				context,
			);
			return;
		}
		sync?.configure(displayName ? [] : exposed, true);
		const sourceDefinition = sourceRuntimeDefinition(definition, ownedNames);
		const observeCell = visible
			? createVisibleCellObserver(viewSync, sourceDefinition, displayName, sync, renderError)
			: createRuntimeInputObserver(observer, viewSync, sourceDefinition);
		defineRuntimeCell(
			runtime,
			root,
			cell,
			sourceDefinition,
			observeDiagnostics(
				exposed.length ? observeCell : observeAnonymous(observeCell, context.values, target.index, context.diagnostics),
				target,
				context,
			),
			{
				document: runtimeDocument(runtime),
				notebookNames,
				runtimeProfile,
			},
		);
		defineSyncObservers(
			runtime,
			sync,
			exposed,
			context.values,
			target.index,
			runtimeOutputNames(definition),
			target,
			context,
		);
	} catch (error) {
		const diagnostic = reportCell(
			target,
			context,
			error,
			"runtime",
			"rendering",
			"packages/runtime/src/cell-renderer.ts",
			"define cell",
			"definition",
		);
		context.values.fail(target.index, error, diagnostic);
		root.appendChild(createTopLevelError(error, root.ownerDocument));
		sync?.fail(error, "rendering");
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

function appendSource(target: CellRenderTarget, context: CellRenderContext): void {
	const { wrapper, cell, sync } = target;
	const { signal } = context;
	try {
		if (!signal.aborted) wrapper.appendChild(renderSource(cell, signal, wrapper.ownerDocument));
	} catch (error) {
		reportCell(
			target,
			context,
			error,
			"runtime",
			"rendering",
			"packages/runtime/src/dom.ts",
			"render source",
			"source",
		);
		if (!signal.aborted) wrapper.appendChild(createTopLevelError(error, wrapper.ownerDocument));
		sync?.fail(error, "rendering");
	}
}

function renderVariableCell(
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

function createVisibleCellObserver(
	viewSync: RuntimeViewSync,
	definition: RuntimeCellDefinition,
	displayName: string | null,
	sync?: CellVariableSync,
	onRenderError?: (cause: ObservedCause) => void,
): typeof observe {
	return (state, runtimeDefinition) => {
		let renderFailed = false;
		// Keep the runtime output for variable wiring and clear the display label so
		// selected cell output renders the value directly.
		const observer = safeObserve(state, { ...runtimeDefinition, output: undefined }, (error) => {
			renderFailed = true;
			onRenderError?.(error);
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
			// SAFETY: RuntimeValue includes every ECMAScript value returned by Notebook Kit.
			const nativeValue = value as RuntimeValue;
			if (viewName) viewSync.register(viewName, nativeValue);
			fulfilled(value);
			if (renderFailed || !sync) return;
			if (!displayName) {
				sync.fulfilled("display");
				return;
			}
			sync.fulfilled("display", displayName, nativeValue);
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

function createSyncObserver(
	sync: CellVariableSync | undefined,
	name: string,
	values: NotebookValues,
	index: number,
	target: CellRenderTarget,
	context: CellRenderContext,
): RuntimeObserver {
	const channel = `variable:${name}`;
	return {
		pending() {
			if (context.signal.aborted) return;
			values.pending(index, name);
			sync?.pending(channel);
		},
		fulfilled(value: ObservedValue) {
			if (context.signal.aborted) return;
			try {
				// SAFETY: RuntimeValue includes every ECMAScript value returned by Notebook Kit.
				const native = value as RuntimeValue;
				values.fulfilled(index, name, native);
				sync?.fulfilled(channel, name, native);
			} catch (cause) {
				const diagnostic = reportCell(
					target,
					context,
					cause,
					"runtime",
					"evaluation",
					"packages/runtime/src/cell-renderer.ts",
					"publish cell value",
					channel,
				);
				values.rejected(index, name, cause, diagnostic);
			}
		},
		rejected(cause: ObservedCause) {
			if (context.signal.aborted) return;
			const diagnostic =
				context.diagnostics.getCell(index, "evaluation") ??
				reportCell(
					target,
					context,
					cause,
					"notebook",
					"evaluation",
					"packages/runtime/src/cell-renderer.ts",
					"evaluate variable",
					channel,
					name,
				);
			values.rejected(index, name, cause, diagnostic);
			sync?.rejected(channel, new DiagnosticError(diagnostic), "evaluation", name);
		},
	};
}

function defineSyncObservers(
	runtime: NotebookRuntime,
	sync: CellVariableSync | undefined,
	names: string[],
	values: NotebookValues,
	index: number,
	runtimeNames: readonly string[],
	target: CellRenderTarget,
	context: CellRenderContext,
): void {
	for (const name of new Set([...names, ...runtimeNames])) {
		observeRuntimeVariable(
			runtime,
			name,
			createSyncObserver(names.includes(name) ? sync : undefined, name, values, index, target, context),
		);
	}
}

function observeAnonymous(
	observeCell: typeof observe,
	values: NotebookValues,
	index: number,
	diagnostics: DiagnosticCollector,
): typeof observe {
	return (state, definition) => {
		const observer = observeCell(state, definition);
		return {
			...observer,
			pending() {
				values.pending(index, null);
				observer.pending();
			},
			fulfilled(value) {
				// SAFETY: RuntimeValue includes every native Observable value.
				values.fulfilled(index, null, value as RuntimeValue);
				observer.fulfilled(value);
			},
			rejected(cause) {
				values.rejected(index, null, cause, diagnostics.getCell(index, "evaluation"));
				observer.rejected(cause);
			},
		};
	};
}

function reportCell<Cause>(
	target: CellRenderTarget,
	context: CellRenderContext,
	cause: Cause,
	origin: DiagnosticOrigin,
	phase: DiagnosticPhase,
	component: string,
	operation: string,
	channel: string,
	variable?: string,
): Diagnostic {
	const diagnostic = createDiagnostic(cause, {
		origin,
		phase,
		component,
		operation,
		variable,
		cell: {
			index: target.index,
			id: target.cell.id,
			key: target.key,
			mode: target.cell.mode,
			source: target.cell.value,
		},
	});
	if (!context.signal.aborted) context.diagnostics.report(diagnostic, channel);
	return diagnostic;
}

function observeDiagnostics(
	factory: typeof observe,
	target: CellRenderTarget,
	context: CellRenderContext,
): typeof observe {
	return (state, definition) => {
		const observer = factory(state, definition);
		return {
			...observer,
			pending() {
				if (context.signal.aborted) return;
				context.diagnostics.clearCell(target.index);
				try {
					observer.pending();
				} catch (cause) {
					reportCell(
						target,
						context,
						cause,
						"runtime",
						"evaluation",
						"packages/runtime/src/cell-renderer.ts",
						"observe pending cell",
						"observer",
					);
				}
			},
			fulfilled(value) {
				if (context.signal.aborted) return;
				try {
					observer.fulfilled(value);
				} catch (cause) {
					const diagnostic = reportCell(
						target,
						context,
						cause,
						"runtime",
						"rendering",
						"packages/runtime/src/cell-renderer.ts",
						"observe cell result",
						"observer",
					);
					context.values.fail(target.index, cause, diagnostic);
					target.sync?.fail(cause, "rendering");
				}
			},
			rejected(cause) {
				if (context.signal.aborted) return;
				reportCell(
					target,
					context,
					cause,
					"notebook",
					"evaluation",
					"packages/runtime/src/cell-renderer.ts",
					"evaluate cell",
					"evaluation",
					definition.output,
				);
				try {
					observer.rejected(cause);
				} catch (error) {
					reportCell(
						target,
						context,
						error,
						"runtime",
						"rendering",
						"packages/runtime/src/cell-renderer.ts",
						"render cell error",
						"rendering",
					);
				}
			},
		};
	};
}

function hostOwnedNames(definition: RuntimeCellDefinition, exposed: string[], variableNames: Set<string>): string[] {
	if (definition.autoview || definition.automutable) return [];
	return exposed.filter((name) => variableNames.has(name));
}

function sourceRuntimeDefinition(
	definition: RuntimeCellDefinition,
	ownedNames: readonly string[],
): RuntimeCellDefinition {
	if (!definition.outputs || ownedNames.length === 0) return definition;
	const ownedNameSet = new Set(ownedNames);
	return {
		...definition,
		outputs: definition.outputs.filter((name) => !ownedNameSet.has(name)),
	};
}
