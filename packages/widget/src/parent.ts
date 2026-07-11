import type { InitializeProps, RenderProps } from "@anywidget/types";
import { analyzeNotebook } from "@pyobservablejs/runtime";
import "./widget.css";
import { renderCellProjection, renderNotebookCells } from "./composition";
import { readCellKeys } from "./composition-state";
import { createTopLevelError } from "./dom";
import { NOTEBOOK_MODEL_CHANGE_EVENTS, readNotebookFromModel, type WidgetModel } from "./model";
import type { CellProjectionContext } from "./projection-context";
import { NotebookReadback, syncNotebookGraph, type ReadbackAttempt, type ReadbackView } from "./readback";
import { openNotebookRuntimeSession } from "./session";

type Model = RenderProps<WidgetModel>["model"];
type Rerender = (variables?: Record<string, unknown>) => void;
type RenderAttempt = (
	signal: AbortSignal,
	rerender: Rerender,
	variables: Record<string, unknown> | undefined,
	attempt: ReadbackAttempt,
) => Promise<void> | void;

export type ParentRenderer = {
	render(props: RenderProps<WidgetModel>, projection?: CellProjectionContext): void;
};

export function createParentRenderer(
	model: InitializeProps<WidgetModel>["model"],
	signal: AbortSignal,
): ParentRenderer {
	const readback = new NotebookReadback(model, signal);
	return {
		render(props, projection) {
			if (projection && props.model.get("role") !== "notebook") {
				throw new Error("NotebookCell parent reference does not resolve to a Notebook");
			}
			const view = readback.open(projection ? "projection" : "full", props.signal);
			renderOnModelChanges(
				props.model,
				props.el,
				props.signal,
				view,
				readback,
				(attemptSignal, rerender, variables, attempt) =>
					projection
						? renderCurrentProjection(
								props.model,
								projection,
								props.el,
								attemptSignal,
								rerender,
								readback,
								attempt,
								variables,
							)
						: renderCurrentNotebook(props.model, props.el, attemptSignal, rerender, readback, attempt, variables),
			);
		},
	};
}

function renderOnModelChanges(
	model: Model,
	el: HTMLElement,
	signal: AbortSignal,
	view: ReadbackView,
	readback: NotebookReadback,
	renderAttempt: RenderAttempt,
): void {
	let current = new AbortController();
	let version = 0;
	const rerender: Rerender = (variables) => {
		current.abort();
		current = new AbortController();
		const attemptController = current;
		const attemptSignal = AbortSignal.any([signal, attemptController.signal]);
		const renderVersion = ++version;
		const attempt = readback.start(view);
		const isCurrent = () => !attemptSignal.aborted && renderVersion === version && readback.isCurrent(attempt);
		void Promise.resolve(renderAttempt(attemptSignal, rerender, variables, attempt)).catch((error: unknown) => {
			if (!isCurrent()) return;
			readback.cancel(attempt);
			attemptController.abort();
			el.replaceChildren(createTopLevelError(error));
		});
	};
	const rerenderFromModel = () => rerender();
	for (const event of NOTEBOOK_MODEL_CHANGE_EVENTS) model.on(event, rerenderFromModel);
	signal.addEventListener(
		"abort",
		() => {
			for (const event of NOTEBOOK_MODEL_CHANGE_EVENTS) model.off(event, rerenderFromModel);
			current.abort();
			readback.close(view);
		},
		{ once: true },
	);
	rerender();
}

function renderCurrentNotebook(
	model: Model,
	el: HTMLElement,
	signal: AbortSignal,
	onInputReset: Rerender,
	readback: NotebookReadback,
	attempt: ReadbackAttempt,
	variablesOverride?: Record<string, unknown>,
): void {
	const notebook = readNotebookFromModel(model);
	const analysis = analyzeNotebook(notebook);
	syncNotebookGraph(model, notebook, readCellKeys(model), analysis);
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
		renderNotebookCells({
			model,
			root: session.root,
			notebook,
			analysis,
			runtime: session.runtime,
			options: session.options,
			variablesSync: session.variablesSync,
			signal: session.signal,
			readback,
			attempt,
		});
	} catch (error) {
		session.cleanup();
		throw error;
	}
}

function renderCurrentProjection(
	model: Model,
	projection: CellProjectionContext,
	el: HTMLElement,
	signal: AbortSignal,
	onInputReset: Rerender,
	readback: NotebookReadback,
	attempt: ReadbackAttempt,
	variablesOverride?: Record<string, unknown>,
): void {
	const notebook = readNotebookFromModel(model);
	const analysis = analyzeNotebook(notebook);
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
		renderCellProjection({
			model,
			cellModel: projection.cellModel,
			root: session.root,
			notebook,
			cellIndex: projection.index,
			analysis,
			runtime: session.runtime,
			options: session.options,
			variablesSync: session.variablesSync,
			signal: session.signal,
			readback,
			attempt,
		});
	} catch (error) {
		session.cleanup();
		throw error;
	}
}
