import type { RenderProps } from "@anywidget/types";
import { analyzeNotebook, notebookAffectedIndexes, type WireValues } from "@pyobservablejs/runtime";
import { notebookViewIndexes, renderNotebookView } from "./composition";
import { createTopLevelError } from "./dom";
import {
	readNotebookFromModel,
	readNotebookSessionRef,
	readSelectedCellIndexes,
	readCellKeys,
	SESSION_MODEL_CHANGE_EVENTS,
	VIEW_MODEL_CHANGE_EVENTS,
	type AnyWidgetModel,
	type WidgetModel,
} from "./model";
import { ViewReadback, type ReadbackAttempt } from "./readback";
import { openNotebookRuntimeSession } from "./session";

type Rerender = (variables?: WireValues) => void;

export function renderNotebookViewModel(props: RenderProps<WidgetModel>): void {
	let readback: ViewReadback;
	try {
		readback = new ViewReadback(props.model, props.signal);
	} catch (error) {
		props.el.replaceChildren(createTopLevelError(error));
		return;
	}
	let current = new AbortController();

	const rerender: Rerender = (variables) => {
		current.abort();
		current = new AbortController();
		const attemptController = current;
		const attemptSignal = AbortSignal.any([props.signal, attemptController.signal]);
		const attempt = readback.start();
		const isCurrent = () => !attemptSignal.aborted && readback.isCurrent(attempt);
		void renderCurrentView(props, attemptSignal, resetAndRerender, readback, attempt, variables).catch((cause) => {
			if (!isCurrent()) return;
			props.el.replaceChildren(createTopLevelError(cause));
			readback.fail(attempt, cause, "rendering");
			attemptController.abort();
		});
	};
	const invalidateAndRerender = () => {
		readback.invalidate();
		rerender();
	};
	const resetAndRerender: Rerender = (variables) => {
		readback.invalidate(true);
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
	variablesOverride?: WireValues,
): Promise<void> {
	const requestedIndexes = readSelectedCellIndexes(props.model);
	const sessionRef = readNotebookSessionRef(props.model);
	const sessionModel = await resolveSessionModel(props, sessionRef, signal);
	if (signal.aborted) return;
	if (sessionModel.get("_model_role") !== "session") {
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
	const selectedIndexes = resolveSelectedIndexes(requestedIndexes, notebook.cells.length);
	const renderIndexes = notebookViewIndexes(analysis, selectedIndexes);
	const cellKeys = readCellKeys(sessionModel);
	readback.syncGraph(attempt, analysis, renderIndexes, cellKeys);
	const beginInput = (names: ReadonlySet<string>) => {
		if (!readback.captureState) return;
		readback.beginInput(attempt, notebookAffectedIndexes(analysis, names));
	};
	const session = openNotebookRuntimeSession({
		model: sessionModel,
		el: props.el,
		notebook,
		analysis,
		signal,
		onInputReset,
		onInput: beginInput,
		variablesOverride,
	});
	if (!session) return;
	try {
		renderNotebookView({
			notebook,
			selectedIndexes,
			renderIndexes,
			analysis,
			session,
			readback,
			attempt,
			cellKeys,
		});
	} catch (error) {
		session.cleanup();
		throw error;
	}
}

function resolveSessionModel(
	props: RenderProps<WidgetModel>,
	ref: string,
	signal: AbortSignal,
): Promise<AnyWidgetModel> {
	signal.throwIfAborted();
	const lookup = Promise.resolve().then(() => props.host.getModel<WidgetModel>(ref));
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		lookup.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

function resolveSelectedIndexes(indexes: Set<number> | null, cellCount: number): Set<number> {
	if (indexes === null) return new Set(Array.from({ length: cellCount }, (_, index) => index));
	for (const index of indexes) {
		if (index >= cellCount) throw new Error(`NotebookView cell index ${index} is outside the Notebook session`);
	}
	return indexes;
}
