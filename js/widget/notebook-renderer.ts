import type { RenderProps } from "@anywidget/types";
import { registerAttachments } from "../runtime/attachments";
import { createRuntime, createRuntimeCleanup } from "../runtime/index";
import { createAbortController } from "./abort";
import { writeProgrammaticViewValue } from "./cell-value-sync";
import { notebookViewNames } from "./cell-renderer";
import { createCompositionHost } from "./composition-host";
import { renderComposedCells } from "./composed-cells";
import { createNotebookRoot, createTopLevelError, prepareWidgetShell } from "./dom";
import {
	NOTEBOOK_MODEL_CHANGE_EVENTS,
	readCellRefs,
	readNotebookFromModel,
	readNotebookOptions,
} from "./notebook-model";
import { syncNotebookGraph, syncNotebookValues } from "./notebook-value-sync";
import { createRuntimeVariablesSync } from "./runtime-variables-sync";
import type { WidgetModel } from "./types";

type RenderNotebookWidgetOptions = {
	model: RenderProps<WidgetModel>["model"];
	el: HTMLElement;
	signal: AbortSignal;
	host?: RenderProps<WidgetModel>["host"];
};

/**
 * Render the parent notebook widget and restart the runtime when model traits change.
 */
export function renderNotebookWidget({ model, el, signal, host }: RenderNotebookWidgetOptions): void {
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
	if (signal.aborted) return;

	const notebook = readNotebookFromModel(model);
	const cellRefs = readCellRefs(model.get("_cell_widgets"));
	if (cellRefs.length > 0) {
		if (cellRefs.length !== notebook.cells.length) {
			throw new Error(`Expected ${notebook.cells.length} cell widgets, received ${cellRefs.length}`);
		}
	} else if (notebook.cells.length > 0) {
		throw new Error(`Expected ${notebook.cells.length} cell widgets, received 0`);
	}
	if (cellRefs.length === 0) {
		syncNotebookGraph(model, notebook);
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
		viewNames: notebookViewNames(notebook),
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
