import type { RenderProps } from "@anywidget/types";
import { analyzeNotebook } from "@/runtime";
import "./widget.css";
import {
	createCompositionHost,
	renderComposedCells,
	renderStandaloneCellProjection,
	resolveNotebookModel,
	type CompositionHost,
} from "./composition";
import { readCellCompositionState, readNotebookCompositionState } from "./composition-state";
import { createTopLevelError } from "./dom";
import { NOTEBOOK_MODEL_CHANGE_EVENTS, readNotebookFromModel, readNotebookOptions, type WidgetModel } from "./model";
import {
	markRendered,
	resetGraphSnapshot,
	resetRenderReadback,
	syncNotebookGraph,
	syncNotebookValues,
} from "./readback";
import { openNotebookRuntimeSession } from "./session";

type RenderNotebookWidgetOptions = {
	model: RenderProps<WidgetModel>["model"];
	el: HTMLElement;
	signal: AbortSignal;
	host: CompositionHost;
};

type Rerender = (variables?: Record<string, unknown>) => void;
type RenderAttempt = (
	signal: AbortSignal,
	rerender: Rerender,
	variables: Record<string, unknown> | undefined,
	isCurrent: () => boolean,
) => Promise<void>;

const CELL_MODEL_CHANGE_EVENTS = ["change:_notebook_widget", "change:_notebook_index"] as const;
function render(props: RenderProps<WidgetModel>): void {
	const signal = props.signal;
	if (signal.aborted) return;
	const options = {
		model: props.model,
		el: props.el,
		signal,
		host: createCompositionHost(props.host, props.model),
	};
	if (props.model.get("role") === "cell") {
		renderStandaloneCellWidget(options);
	} else {
		renderNotebookWidget(options);
	}
}

export default { render };

/**
 * Render the parent notebook widget and restart the runtime when model traits change.
 */
function renderNotebookWidget({ model, el, signal, host }: RenderNotebookWidgetOptions): void {
	let resolvedCells = new Set<RenderProps<WidgetModel>["model"]>();
	renderOnModelChanges(
		{ model, el, signal },
		NOTEBOOK_MODEL_CHANGE_EVENTS,
		(attemptSignal, rerender, variables, isCurrent) =>
			renderCurrentNotebook(
				model,
				el,
				attemptSignal,
				host,
				rerender,
				(cell) => {
					if (isCurrent()) resolvedCells.add(cell);
				},
				variables,
			),
		() => {
			for (const cell of resolvedCells) resetRenderReadback(cell);
			resolvedCells = new Set();
		},
	);
}

/**
 * Render a child cell widget by resolving its explicit parent notebook model.
 */
function renderStandaloneCellWidget({ model, el, signal, host }: RenderNotebookWidgetOptions): void {
	renderOnModelChanges({ model, el, signal }, CELL_MODEL_CHANGE_EVENTS, (attemptSignal, rerender, variables) =>
		renderCurrentStandaloneCell(model, el, attemptSignal, host, rerender, variables),
	);
}

function renderOnModelChanges(
	{ model, el, signal }: Pick<RenderNotebookWidgetOptions, "model" | "el" | "signal">,
	events: readonly string[],
	renderAttempt: RenderAttempt,
	beforeRerender: () => void = () => {},
): void {
	let current = new AbortController();
	let version = 0;
	const rerender: Rerender = (variables) => {
		beforeRerender();
		current.abort();
		current = new AbortController();
		const attempt = current;
		const attemptSignal = AbortSignal.any([signal, attempt.signal]);
		const renderVersion = ++version;
		const isCurrent = () => !attemptSignal.aborted && renderVersion === version;
		void renderAttempt(attemptSignal, rerender, variables, isCurrent).catch((error: unknown) => {
			if (!isCurrent()) return;
			attempt.abort();
			el.replaceChildren(createTopLevelError(error));
		});
	};
	const rerenderFromModel = () => rerender();
	for (const event of events) model.on(event, rerenderFromModel);
	signal.addEventListener(
		"abort",
		() => {
			for (const event of events) model.off(event, rerenderFromModel);
			current.abort();
		},
		{ once: true },
	);
	rerender();
}

/**
 * Build one notebook runtime for the current model snapshot.
 */
async function renderCurrentNotebook(
	model: RenderProps<WidgetModel>["model"],
	el: HTMLElement,
	signal: AbortSignal,
	host: CompositionHost,
	onInputReset: (variables: Record<string, unknown>) => void,
	onCellResolved: (cell: RenderProps<WidgetModel>["model"]) => void,
	variablesOverride?: Record<string, unknown>,
): Promise<void> {
	resetRenderReadback(model);
	resetGraphSnapshot(model);

	const composition = readNotebookCompositionState(model);
	const notebook = readNotebookFromModel(model);
	const analysis = analyzeNotebook(notebook);
	if (composition.cellRefs.length > 0) {
		if (composition.cellRefs.length !== notebook.cells.length) {
			throw new Error(`Expected ${notebook.cells.length} cell widgets, received ${composition.cellRefs.length}`);
		}
	} else if (notebook.cells.length > 0) {
		throw new Error(`Expected ${notebook.cells.length} cell widgets, received 0`);
	}
	if (composition.cellRefs.length === 0) {
		syncNotebookGraph(model, notebook, composition.cellKeys, analysis);
		syncNotebookValues(model, []);
		markRendered(model);
	}
	const session = openNotebookRuntimeSession({
		model,
		el,
		notebook,
		analysis,
		signal,
		onInputReset,
		variablesOverride,
	});
	if (!session) return;

	try {
		if (composition.cellRefs.length > 0) {
			await renderComposedCells({
				model,
				root: session.root,
				notebook,
				composition,
				analysis,
				runtime: session.runtime,
				options: session.options,
				variablesSync: session.variablesSync,
				signal: session.signal,
				host,
				onCellResolved,
			});
		}
	} catch (error) {
		session.cleanup();
		throw error;
	}
}

/**
 * Build one projected runtime for a directly displayed NotebookCell.
 */
async function renderCurrentStandaloneCell(
	model: RenderProps<WidgetModel>["model"],
	el: HTMLElement,
	signal: AbortSignal,
	host: CompositionHost,
	onInputReset: (variables: Record<string, unknown>) => void,
	variablesOverride?: Record<string, unknown>,
): Promise<void> {
	const cellComposition = readCellCompositionState(model);
	const parentModel = await resolveNotebookModel(host, cellComposition.parentRef, signal);
	if (signal.aborted) return;

	const notebook = readNotebookFromModel(parentModel);
	const analysis = analyzeNotebook(notebook);
	const session = openNotebookRuntimeSession({
		model: parentModel,
		el,
		notebook,
		analysis,
		signal,
		onInputReset,
		variablesOverride,
	});
	if (!session) return;
	const rerenderFromParent = () => onInputReset(readNotebookOptions(parentModel).variables);
	for (const event of NOTEBOOK_MODEL_CHANGE_EVENTS) parentModel.on(event, rerenderFromParent);
	session.signal.addEventListener(
		"abort",
		() => {
			for (const event of NOTEBOOK_MODEL_CHANGE_EVENTS) parentModel.off(event, rerenderFromParent);
		},
		{ once: true },
	);

	try {
		renderStandaloneCellProjection({
			parentModel,
			cellModel: model,
			root: session.root,
			notebook,
			cellIndex: cellComposition.index,
			analysis,
			runtime: session.runtime,
			options: session.options,
			variablesSync: session.variablesSync,
			signal: session.signal,
		});
	} catch (error) {
		session.cleanup();
		throw error;
	}
}
