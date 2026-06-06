import type { InitializeProps, RenderProps } from "@anywidget/types";
import { createTopLevelError, markWidgetShell } from "./dom";
import type { WidgetModel } from "./types";

/**
 * Child cell widgets hold trait state for the parent notebook render.
 */
export function initializeCellWidget({ model }: InitializeProps<WidgetModel>): undefined {
	void model;
	return undefined;
}

/**
 * Render a child widget only through its parent notebook display.
 */
export function renderCellWidget(
	_model: RenderProps<WidgetModel>["model"],
	el: HTMLElement,
	signal: AbortSignal,
): void {
	if (signal.aborted) return;
	markWidgetShell(el);
	el.replaceChildren(createTopLevelError(new Error("NotebookCell renders only inside its parent Notebook display")));
}
