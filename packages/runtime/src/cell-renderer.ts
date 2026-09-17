import { createCellEvaluation, type CellEvaluation } from "./cell-evaluation";
import { hostOwnedNames, sourceRuntimeDefinition } from "./ownership";
import type { Cell } from "@observablehq/notebook-kit";
import {
	observe,
	type Definition as RuntimeDefinition,
	type DisplayState,
	type NotebookRuntime,
} from "@observablehq/notebook-kit/runtime";
import { defineCompiledRuntimeCell, defineRuntimeCell } from "./execution";
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
import { type DiagnosticCollector } from "./diagnostics";

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

type EvaluatedCellContext = CellRenderContext & { evaluation: CellEvaluation };

export function renderCellTarget(target: CellRenderTarget, context: CellRenderContext): void {
	const evaluation = createCellEvaluation({
		cell: {
			index: target.index,
			id: target.cell.id,
			key: target.key,
			mode: target.cell.mode,
			source: target.cell.value,
		},
		...context,
		sync: target.sync,
	});
	const evaluated = { ...context, evaluation };
	const { wrapper, cell } = target;
	wrapper.replaceChildren();
	defineCell(target, evaluated, createCellOutput(wrapper, cell));
	if (target.visible && target.showSource && cell.pinned) appendSource(target, evaluated);
}

function defineCell(target: CellRenderTarget, context: EvaluatedCellContext, root: HTMLDivElement): void {
	const { cell, sync, cellName, visible } = target;
	const { runtime, viewSync, variableNames, notebookNames, runtimeProfile } = context;
	try {
		const analysis = context.analysis.cells[target.index];
		if (!analysis) throw new Error(`Missing analysis for notebook cell ${target.index}`);
		if (!analysis.definition) {
			context.evaluation.analysisFailure(analysis.error);
			root.appendChild(createTopLevelError(analysis.error, root.ownerDocument));
			return;
		}
		const definition = analysis.definition;
		const exposed = exposedVariableNames(definition);
		const displayName = exposed.length === 0 && cellName ? cellName : null;
		const ownedNames = hostOwnedNames(definition, exposed, variableNames);
		const renderError = (cause: ObservedCause) =>
			context.evaluation.report(
				cause,
				{
					origin: "runtime",
					phase: "rendering",
					component: "packages/runtime/src/cell-renderer.ts",
					operation: "render cell",
				},
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
			context.evaluation.observeVariables(runtime, exposed, runtimeOutputNames(definition));
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
		context.evaluation.observeVariables(runtime, exposed, runtimeOutputNames(definition));
	} catch (error) {
		const diagnostic = context.evaluation.report(
			error,
			{
				origin: "runtime",
				phase: "rendering",
				component: "packages/runtime/src/cell-renderer.ts",
				operation: "define cell",
			},
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

function appendSource(target: CellRenderTarget, context: EvaluatedCellContext): void {
	const { wrapper, cell, sync } = target;
	const { signal } = context;
	try {
		if (!signal.aborted) wrapper.appendChild(renderSource(cell, signal, wrapper.ownerDocument));
	} catch (error) {
		context.evaluation.report(
			error,
			{ origin: "runtime", phase: "rendering", component: "packages/runtime/src/dom.ts", operation: "render source" },
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

function observeDiagnostics(
	factory: typeof observe,
	target: CellRenderTarget,
	context: EvaluatedCellContext,
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
					context.evaluation.report(
						cause,
						{
							origin: "runtime",
							phase: "evaluation",
							component: "packages/runtime/src/cell-renderer.ts",
							operation: "observe pending cell",
						},
						"observer",
					);
				}
			},
			fulfilled(value) {
				if (context.signal.aborted) return;
				try {
					observer.fulfilled(value);
				} catch (cause) {
					const diagnostic = context.evaluation.report(
						cause,
						{
							origin: "runtime",
							phase: "rendering",
							component: "packages/runtime/src/cell-renderer.ts",
							operation: "observe cell result",
						},
						"observer",
					);
					context.values.fail(target.index, cause, diagnostic);
					target.sync?.fail(cause, "rendering");
				}
			},
			rejected(cause) {
				if (context.signal.aborted) return;
				context.evaluation.report(
					cause,
					{
						origin: "notebook",
						phase: "evaluation",
						component: "packages/runtime/src/cell-renderer.ts",
						operation: "evaluate cell",
						variable: definition.output,
					},
					"evaluation",
				);
				try {
					observer.rejected(cause);
				} catch (error) {
					context.evaluation.report(
						error,
						{
							origin: "runtime",
							phase: "rendering",
							component: "packages/runtime/src/cell-renderer.ts",
							operation: "render cell error",
						},
						"rendering",
					);
				}
			},
		};
	};
}
