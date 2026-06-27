import type { InitializeProps, RenderProps } from "@anywidget/types";
import type { NotebookRuntime } from "@observablehq/notebook-kit/runtime";
import { analyzeNotebook, notebookViewNamesFromAnalysis } from "@/runtime/graph";
import { createRuntime, createRuntimeCleanup, registerAttachments } from "@/runtime";
import {
	createCompositionHost,
	renderComposedCells,
	renderStandaloneCellProjection,
	type CompositionHost,
} from "./composition";
import { createNotebookRoot, createTopLevelError, prepareWidgetShell } from "./dom";
import {
	NOTEBOOK_MODEL_CHANGE_EVENTS,
	createRuntimeVariablesSync,
	markRendered,
	readCellKeys,
	readCellRefs,
	readNotebookFromModel,
	readNotebookOptions,
	resetGraphSnapshot,
	resetRenderReadback,
	syncNotebookGraph,
	syncNotebookValues,
	writeProgrammaticViewValue,
	type WidgetModel,
} from "./state";
import { installNotebookThemeStyles } from "./themes";

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
	prepareWidgetShell(el);
	const ownerRoot = el.getRootNode();
	installNotebookThemeStyles(ownerRoot instanceof ShadowRoot ? ownerRoot : el.ownerDocument);
	if (signal.aborted) return;

	const cellKeys = readCellKeys(model);
	const cellRefs = readCellRefs(model.get("_cell_widgets"));
	const compositionHost = createCompositionHost(host, model);
	if (cellRefs.length > 0) {
		await resetResolvedCellReadback(compositionHost, cellRefs, signal);
		if (signal.aborted) return;
	}

	const notebook = readNotebookFromModel(model);
	const analysis = analyzeNotebook(notebook);
	if (cellRefs.length > 0) {
		if (cellRefs.length !== notebook.cells.length) {
			throw new Error(`Expected ${notebook.cells.length} cell widgets, received ${cellRefs.length}`);
		}
	} else if (notebook.cells.length > 0) {
		throw new Error(`Expected ${notebook.cells.length} cell widgets, received 0`);
	}
	if (cellRefs.length === 0) {
		syncNotebookGraph(model, notebook, cellKeys, analysis);
		syncNotebookValues(model, []);
		markRendered(model);
	}

	const root = createNotebookRoot(el, notebook.theme);
	const options = readNotebookOptions(model, variablesOverride);
	const attachmentRegistry = registerAttachments(options.attachments);
	let runtime: NotebookRuntime;
	try {
		runtime = createRuntime(root, el, options, attachmentRegistry);
	} catch (error) {
		attachmentRegistry.cleanup();
		throw error;
	}
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
				compositionHost,
				cellKeys,
			);
		}
	} catch (error) {
		if (!signal.aborted) cleanup();
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
	prepareWidgetShell(el);
	const parentModel = await resolveParentNotebookModel(model, host, signal);
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
	const cellIndex = readStandaloneCellIndex(model);
	const analysis = analyzeNotebook(notebook);
	const root = createNotebookRoot(el, notebook.theme);
	const ownerRoot = el.getRootNode();
	installNotebookThemeStyles(ownerRoot instanceof ShadowRoot ? ownerRoot : el.ownerDocument);
	const options = readNotebookOptions(parentModel, variablesOverride);
	const attachmentRegistry = registerAttachments(options.attachments);
	let runtime: NotebookRuntime;
	try {
		runtime = createRuntime(root, el, options, attachmentRegistry);
	} catch (error) {
		attachmentRegistry.cleanup();
		throw error;
	}
	const cleanup = createRuntimeCleanup(runtime, attachmentRegistry);
	const variablesSync = createRuntimeVariablesSync({
		model: parentModel,
		runtime,
		options,
		viewNames: notebookViewNamesFromAnalysis(analysis),
		signal,
		onReset: onInputReset,
		writeViewValue: writeProgrammaticViewValue,
	});
	signal.addEventListener("abort", cleanup, { once: true });

	try {
		renderStandaloneCellProjection(
			parentModel,
			model,
			root,
			notebook,
			cellIndex,
			analysis,
			runtime,
			options,
			variablesSync,
			signal,
		);
	} catch (error) {
		if (!signal.aborted) cleanup();
		throw error;
	}
}

async function resolveParentNotebookModel(
	model: RenderProps<WidgetModel>["model"],
	host: RenderProps<WidgetModel>["host"] | undefined,
	signal: AbortSignal,
): Promise<RenderProps<WidgetModel>["model"]> {
	const parentRef = model.get("_notebook_widget");
	if (typeof parentRef !== "string" || !parentRef) {
		throw new Error("NotebookCell has no parent Notebook reference");
	}
	const parentModel = await createCompositionHost(host, model).getModel(parentRef, signal);
	if (signal.aborted) throw new Error(`Unable to resolve parent Notebook widget ${parentRef}`);
	if (!parentModel) throw new Error(`Unknown parent Notebook widget ${parentRef}`);
	if (parentModel.get("role") !== "notebook") throw new Error(`Parent widget ${parentRef} is not a Notebook`);
	return parentModel;
}

function readStandaloneCellIndex(model: RenderProps<WidgetModel>["model"]): number {
	const index = model.get("_notebook_index");
	if (!Number.isInteger(index) || (index as number) < 0) {
		throw new Error("NotebookCell has no parent Notebook index");
	}
	return index as number;
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
