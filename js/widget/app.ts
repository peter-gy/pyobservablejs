import type { InitializeProps, RenderProps } from "@anywidget/types";
import { analyzeNotebook } from "@/runtime/graph";
import {
	createCompositionHost,
	renderComposedCells,
	renderStandaloneCellProjection,
	resolveNotebookModel,
	type CompositionHost,
} from "./composition";
import { readCellCompositionState, readNotebookCompositionState } from "./composition-state";
import { createTopLevelError } from "./dom";
import { openNotebookRuntimeSession } from "./session";
import {
	NOTEBOOK_MODEL_CHANGE_EVENTS,
	markRendered,
	readNotebookFromModel,
	readNotebookOptions,
	resetGraphSnapshot,
	resetRenderReadback,
	syncNotebookGraph,
	syncNotebookValues,
	type WidgetModel,
} from "./state";

type RenderNotebookWidgetOptions = {
	model: RenderProps<WidgetModel>["model"];
	el: HTMLElement;
	signal: AbortSignal;
	host?: RenderProps<WidgetModel>["host"];
};

const CELL_MODEL_CHANGE_EVENTS = ["change:_notebook_widget", "change:_notebook_index"] as const;
const READBACK_RESET_LOOKUP_TIMEOUT_MS = 50;

function initialize({ model }: InitializeProps<WidgetModel> & { signal?: AbortSignal }): undefined {
	void model;
	return undefined;
}

function render(props: RenderProps<WidgetModel> & { signal?: AbortSignal }): void {
	const signal = props.signal ?? new AbortController().signal;
	if (signal.aborted) return;
	const options = {
		model: props.model,
		el: props.el,
		signal,
		host: props.host,
	};
	if (props.model.get("role") === "cell") {
		renderStandaloneCellWidget(options);
	} else {
		renderNotebookWidget(options);
	}
}

export default { initialize, render };

/**
 * Render the parent notebook widget and restart the runtime when model traits change.
 */
function renderNotebookWidget({ model, el, signal, host }: RenderNotebookWidgetOptions): void {
	let current = createAbortController(signal);
	let version = 0;
	const rerender = (variables?: Record<string, unknown>) => {
		current.abort();
		current = createAbortController(signal);
		const attempt = current;
		const renderVersion = ++version;
		void renderCurrentNotebook(model, el, attempt.signal, host, rerender, variables).catch((error: unknown) => {
			if (attempt.signal.aborted || renderVersion !== version) return;
			attempt.abort();
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
		},
		{ once: true },
	);
	rerender();
}

/**
 * Render a child cell widget by resolving its explicit parent notebook model.
 */
function renderStandaloneCellWidget({ model, el, signal, host }: RenderNotebookWidgetOptions): void {
	let current = createAbortController(signal);
	let version = 0;
	const rerender = (variables?: Record<string, unknown>) => {
		current.abort();
		current = createAbortController(signal);
		const attempt = current;
		const renderVersion = ++version;
		void renderCurrentStandaloneCell(model, el, attempt.signal, host, rerender, variables).catch((error: unknown) => {
			if (attempt.signal.aborted || renderVersion !== version) return;
			attempt.abort();
			el.replaceChildren(createTopLevelError(error));
		});
	};
	const rerenderFromModel = () => rerender();

	for (const event of CELL_MODEL_CHANGE_EVENTS) model.on(event, rerenderFromModel);
	signal.addEventListener(
		"abort",
		() => {
			for (const event of CELL_MODEL_CHANGE_EVENTS) model.off(event, rerenderFromModel);
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
	host: RenderProps<WidgetModel>["host"] | undefined,
	onInputReset: (variables: Record<string, unknown>) => void,
	variablesOverride?: Record<string, unknown>,
): Promise<void> {
	resetRenderReadback(model);
	resetGraphSnapshot(model);

	const composition = readNotebookCompositionState(model);
	const compositionHost = createCompositionHost(host, model);
	if (composition.cellRefs.length > 0) {
		await resetResolvedCellReadback(compositionHost, composition.cellRefs, signal);
		if (signal.aborted) return;
	}

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
				signal,
				host: compositionHost,
			});
		}
	} catch (error) {
		if (!signal.aborted) session.cleanup();
		throw error;
	}
}

async function resetResolvedCellReadback(
	host: CompositionHost,
	cellRefs: readonly string[],
	signal: AbortSignal,
): Promise<void> {
	await Promise.all(
		cellRefs.map(async (ref) => {
			try {
				const childModel = await modelLookupForReadbackReset(host, ref, signal);
				if (!signal.aborted && childModel) resetRenderReadback(childModel);
			} catch {
				return;
			}
		}),
	);
}

async function modelLookupForReadbackReset(
	host: CompositionHost,
	ref: string,
	signal: AbortSignal,
): Promise<RenderProps<WidgetModel>["model"] | undefined> {
	return await Promise.race([
		host.getModel(ref, signal),
		new Promise<undefined>((resolve) => {
			if (signal.aborted) {
				resolve(undefined);
				return;
			}
			const timeout = window.setTimeout(() => resolve(undefined), READBACK_RESET_LOOKUP_TIMEOUT_MS);
			signal.addEventListener(
				"abort",
				() => {
					window.clearTimeout(timeout);
					resolve(undefined);
				},
				{ once: true },
			);
		}),
	]);
}

/**
 * Build one projected runtime for a directly displayed NotebookCell.
 */
async function renderCurrentStandaloneCell(
	model: RenderProps<WidgetModel>["model"],
	el: HTMLElement,
	signal: AbortSignal,
	host: RenderProps<WidgetModel>["host"] | undefined,
	onInputReset: (variables: Record<string, unknown>) => void,
	variablesOverride?: Record<string, unknown>,
): Promise<void> {
	const cellComposition = readCellCompositionState(model);
	const compositionHost = createCompositionHost(host, model);
	const parentModel = await resolveNotebookModel(compositionHost, cellComposition.parentRef, signal);
	if (signal.aborted) return;
	const rerenderFromParent = () => onInputReset(readNotebookOptions(parentModel).variables);
	for (const event of NOTEBOOK_MODEL_CHANGE_EVENTS) parentModel.on(event, rerenderFromParent);
	signal.addEventListener(
		"abort",
		() => {
			for (const event of NOTEBOOK_MODEL_CHANGE_EVENTS) parentModel.off(event, rerenderFromParent);
		},
		{ once: true },
	);

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
			signal,
		});
	} catch (error) {
		if (!signal.aborted) session.cleanup();
		throw error;
	}
}

/**
 * Create a child controller that aborts with its parent and removes its parent
 * listener when the child finishes first.
 */
function createAbortController(parent: AbortSignal): AbortController {
	const controller = new AbortController();
	const abort = () => controller.abort();
	if (parent.aborted) {
		controller.abort();
	} else {
		parent.addEventListener("abort", abort, { once: true });
		controller.signal.addEventListener("abort", () => parent.removeEventListener("abort", abort), {
			once: true,
		});
	}
	return controller;
}
