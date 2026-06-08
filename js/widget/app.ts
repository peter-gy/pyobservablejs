import type { InitializeProps, RenderProps } from "@anywidget/types";
import { analyzeNotebook, notebookViewNamesFromAnalysis } from "../notebook/graph";
import { createRuntime, createRuntimeCleanup, registerAttachments } from "../runtime";
import { createCompositionHost, renderComposedCells } from "./composition";
import { createNotebookRoot, createTopLevelError, prepareWidgetShell } from "./dom";
import { NOTEBOOK_MODEL_CHANGE_EVENTS, readCellRefs, readNotebookFromModel, readNotebookOptions } from "./model";
import { createRuntimeVariablesSync, syncNotebookGraph, syncNotebookValues, writeProgrammaticViewValue } from "./sync";
import { installNotebookThemeStyles } from "./themes";
import type { WidgetModel } from "./model";

type RenderNotebookWidgetOptions = {
	model: RenderProps<WidgetModel>["model"];
	el: HTMLElement;
	signal: AbortSignal;
	host?: RenderProps<WidgetModel>["host"];
};

function initialize({ model }: InitializeProps<WidgetModel> & { signal?: AbortSignal }): undefined {
	void model;
	return undefined;
}

function render(props: RenderProps<WidgetModel> & { signal?: AbortSignal }): void {
	const signal = props.signal ?? new AbortController().signal;
	if (signal.aborted) return;
	renderNotebookWidget({
		model: props.model,
		el: props.el,
		signal,
		host: props.host,
	});
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
	prepareWidgetShell(el);
	const ownerRoot = el.getRootNode();
	installNotebookThemeStyles(ownerRoot instanceof ShadowRoot ? ownerRoot : el.ownerDocument);
	if (signal.aborted) return;

	const notebook = readNotebookFromModel(model);
	const analysis = analyzeNotebook(notebook);
	const cellRefs = readCellRefs(model.get("_cell_widgets"));
	if (cellRefs.length > 0) {
		if (cellRefs.length !== notebook.cells.length) {
			throw new Error(`Expected ${notebook.cells.length} cell widgets, received ${cellRefs.length}`);
		}
	} else if (notebook.cells.length > 0) {
		throw new Error(`Expected ${notebook.cells.length} cell widgets, received 0`);
	}
	if (cellRefs.length === 0) {
		syncNotebookGraph(model, notebook, [], analysis);
		syncNotebookValues(model, []);
	}

	const root = createNotebookRoot(el, notebook.theme);
	const options = readNotebookOptions(model, variablesOverride);
	const attachmentRegistry = registerAttachments(options.attachments);
	const runtime = createRuntime(root, el, options, attachmentRegistry);
	const cleanup = createRuntimeCleanup(runtime, attachmentRegistry);
	const variablesSync = createRuntimeVariablesSync({
		model,
		runtime,
		options,
		viewNames: notebookViewNamesFromAnalysis(analysis),
		signal,
		onReset: onInputReset,
		writeViewValue: writeProgrammaticViewValue,
	});
	signal.addEventListener("abort", cleanup, { once: true });

	try {
		if (cellRefs.length > 0) {
			await renderComposedCells(
				model,
				root,
				notebook,
				cellRefs,
				analysis,
				runtime,
				options,
				variablesSync,
				signal,
				createCompositionHost(host, model),
			);
		}
	} catch (error) {
		if (!signal.aborted) cleanup();
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
