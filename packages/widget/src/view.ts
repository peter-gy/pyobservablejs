import type { RenderProps } from "@anywidget/types";
import { analyzeNotebook } from "@pyobservablejs/runtime";
import { notebookViewIndexes, renderNotebookView } from "./composition";
import { createTopLevelError } from "./dom";
import {
	readNotebookFromModel,
	SESSION_MODEL_CHANGE_EVENTS,
	VIEW_MODEL_CHANGE_EVENTS,
	type AnyWidgetModel,
	type WidgetModel,
} from "./model";
import { ViewReadback, syncNotebookGraph, type ReadbackAttempt } from "./readback";
import { openNotebookRuntimeSession } from "./session";
import { readCellKeys, readNotebookViewState } from "./view-state";

type Rerender = (variables?: Record<string, unknown>) => void;

export function renderNotebookViewModel(props: RenderProps<WidgetModel>): void {
	const readback = new ViewReadback(props.model, props.signal);
	readback.invalidate();
	let current = new AbortController();
	let version = 0;

	const rerender: Rerender = (variables) => {
		current.abort();
		current = new AbortController();
		const attemptController = current;
		const attemptSignal = AbortSignal.any([props.signal, attemptController.signal]);
		const renderVersion = ++version;
		const attempt = readback.start();
		const isCurrent = () => !attemptSignal.aborted && renderVersion === version && readback.isCurrent(attempt);
		void renderCurrentView(props, attemptSignal, resetAndRerender, readback, attempt, variables).catch(
			(error: unknown) => {
				if (!isCurrent()) return;
				readback.cancel(attempt);
				attemptController.abort();
				props.el.replaceChildren(createTopLevelError(error));
			},
		);
	};
	const invalidateAndRerender = () => {
		readback.invalidate();
		rerender();
	};
	const resetAndRerender: Rerender = (variables) => {
		readback.invalidate();
		rerender(variables);
	};
	for (const event of VIEW_MODEL_CHANGE_EVENTS) props.model.on(event, invalidateAndRerender);
	props.signal.addEventListener(
		"abort",
		() => {
			for (const event of VIEW_MODEL_CHANGE_EVENTS) props.model.off(event, invalidateAndRerender);
			current.abort();
		},
		{ once: true },
	);
	rerender();
}

async function renderCurrentView(
	props: RenderProps<WidgetModel>,
	signal: AbortSignal,
	onInputReset: Rerender,
	readback: ViewReadback,
	attempt: ReadbackAttempt,
	variablesOverride?: Record<string, unknown>,
): Promise<void> {
	const state = readNotebookViewState(props.model);
	const sessionModel = await resolveSessionModel(props, state.sessionRef, signal);
	if (signal.aborted) return;
	if (sessionModel.get("role") !== "session") {
		throw new Error("NotebookView reference does not resolve to a Notebook session");
	}

	const invalidate = () => onInputReset();
	for (const event of SESSION_MODEL_CHANGE_EVENTS) sessionModel.on(event, invalidate);
	signal.addEventListener(
		"abort",
		() => {
			for (const event of SESSION_MODEL_CHANGE_EVENTS) sessionModel.off(event, invalidate);
		},
		{ once: true },
	);

	const notebook = readNotebookFromModel(sessionModel);
	const analysis = analyzeNotebook(notebook);
	const selectedIndexes = normalizeSelectedIndexes(state.cellIndexes, notebook.cells.length);
	const renderIndexes = notebookViewIndexes(analysis, selectedIndexes);
	const cellKeys = readCellKeys(sessionModel);
	syncNotebookGraph(props.model, analysis, renderIndexes, cellKeys);
	const session = openNotebookRuntimeSession({
		model: sessionModel,
		el: props.el,
		notebook,
		analysis,
		signal,
		onInputReset,
		variablesOverride,
	});
	if (!session) return;
	try {
		renderNotebookView({
			root: session.root,
			notebook,
			selectedIndexes,
			renderIndexes,
			analysis,
			session,
			options: session.options,
			signal: session.signal,
			readback,
			attempt,
			cellKeys,
		});
	} catch (error) {
		session.cleanup();
		throw error;
	}
}

function normalizeSelectedIndexes(indexes: number[] | null, cellCount: number): Set<number> {
	if (indexes === null) return new Set(Array.from({ length: cellCount }, (_, index) => index));
	for (const index of indexes) {
		if (index >= cellCount) throw new Error(`NotebookView cell index ${index} is outside the Notebook session`);
	}
	return new Set(indexes);
}

function resolveSessionModel(
	props: RenderProps<WidgetModel>,
	ref: string,
	signal: AbortSignal,
): Promise<AnyWidgetModel> {
	const message = `Unable to resolve Notebook session ${ref}`;
	if (signal.aborted) return Promise.reject(new Error(message));
	return abortable(
		Promise.resolve().then(() => props.host.getModel<WidgetModel>(ref)),
		signal,
		message,
	);
}

function abortable<T>(lookup: Promise<T>, signal: AbortSignal, abortMessage: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		const onAbort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(new Error(abortMessage));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		lookup.then(
			(value) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			},
		);
	});
}
