import type { RenderProps } from "@anywidget/types";
import { transpile } from "@observablehq/notebook-kit";
import { readNotebookVariables } from "../model/values";
import type { WidgetModel } from "../model/types";
import { createRuntime, createRuntimeCleanup } from "../runtime";
import { registerAttachments } from "../runtime/attachments";
import { createAbortController } from "./abort";
import { createCellModelSync, writeProgrammaticViewValue } from "./cell-value-sync";
import { notebookViewNames, renderCell } from "./cell-renderer";
import { appendCellWrapper, createNotebookRoot, prepareWidgetShell } from "./dom";
import { createRuntimeVariablesSync } from "./runtime-variables-sync";
import { defineStandaloneDependencyCells } from "./standalone-dependencies";
import { bindStandaloneDependencyInvalidation } from "./standalone-invalidation";
import type { CellRenderContext } from "./types";

/**
 * Render a direct child cell access such as `nb.cells[1]` in its own runtime.
 *
 * Standalone cells cannot reuse DOM output from the parent notebook. They build
 * a fresh Observable runtime and hydrate dependencies from sibling models,
 * parent runtime imports, and source-backed OJS cells.
 */
export function renderStandaloneCellWidget(
	model: RenderProps<WidgetModel>["model"],
	el: HTMLElement,
	context: CellRenderContext,
	signal: AbortSignal,
): void {
	prepareWidgetShell(el);
	if (signal.aborted) return;
	const renderController = createAbortController(signal);
	const renderSignal = renderController.signal;
	bindStandaloneDependencyInvalidation(model, context, renderSignal, () => {
		renderController.abort();
		if (!signal.aborted) {
			renderStandaloneCellWidget(
				model,
				el,
				{ ...context, options: { ...context.options, variables: readNotebookVariables(context.notebookModel) } },
				signal,
			);
		}
	});

	const root = createNotebookRoot(el, context.notebook.theme);
	const attachmentRegistry = registerAttachments(context.options.attachments);
	const runtime = createRuntime(root, el, context.options, attachmentRegistry);
	const cleanup = createRuntimeCleanup(runtime, attachmentRegistry);
	const variablesSync = createRuntimeVariablesSync({
		model: context.notebookModel,
		runtime,
		options: context.options,
		viewNames: notebookViewNames(context.notebook),
		signal: renderSignal,
		onReset(variables) {
			renderController.abort();
			if (!signal.aborted) {
				renderStandaloneCellWidget(model, el, { ...context, options: { ...context.options, variables } }, signal);
			}
		},
		writeViewValue: writeProgrammaticViewValue,
	});
	renderSignal.addEventListener("abort", () => cleanupStandaloneRuntime(el, cleanup), { once: true });

	try {
		const definition = transpile(context.cell, { resolveLocalImports: true });
		defineStandaloneDependencyCells(runtime, context, definition, renderSignal);
		const wrapper = appendCellWrapper(root, { standalone: true });
		renderCell({
			wrapper,
			runtime,
			cell: context.cell,
			showSource: context.showSource,
			sync: createCellModelSync(model, renderSignal, variablesSync),
			signal: renderSignal,
			cellName: model.get("name"),
		});
		variablesSync.applyInitialViews();
	} catch (error) {
		if (!renderSignal.aborted) cleanup();
		throw error;
	}
}

function cleanupStandaloneRuntime(container: HTMLElement, cleanup: () => void): void {
	const children = Array.from(container.childNodes);
	cleanup();
	if (container.childNodes.length === 0) container.replaceChildren(...children);
}
