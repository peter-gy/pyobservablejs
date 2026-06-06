import type { InitializeProps, RenderProps } from "@anywidget/types";
import { renderNotebookWidget } from "./notebook-renderer";
import type { WidgetModel } from "./types";
import "@observablehq/notebook-kit/index.css";
import "@observablehq/notebook-kit/theme-air.css";
import "./styles.css";

const WIDGET_CLASS_NAME = "pyobservablejs";
const ERROR_CLASS_NAME = "pyobservablejs-error";

/**
 * Initialize child cell widgets as trait-state handles.
 */
function initialize({ model }: InitializeProps<WidgetModel> & { signal?: AbortSignal }): undefined {
	void model;
	return undefined;
}

/**
 * Dispatch notebook and child-cell render requests to their owning modules.
 */
function render(props: RenderProps<WidgetModel> & { signal?: AbortSignal }): void {
	const signal = props.signal ?? new AbortController().signal;
	if (signal.aborted) return;
	if (props.model.get("role") === "cell") {
		renderCellWidget(props.el, signal);
		return;
	}
	renderNotebook(props, signal);
}

function renderNotebook(props: RenderProps<WidgetModel>, signal: AbortSignal): void {
	try {
		if (signal.aborted) return;
		renderNotebookWidget({
			model: props.model,
			el: props.el,
			signal,
			host: props.host,
		});
	} catch (error) {
		if (!signal.aborted) props.el.replaceChildren(createTopLevelError(error));
	}
}

function renderCellWidget(el: HTMLElement, signal: AbortSignal): void {
	if (signal.aborted) return;
	el.classList.add(WIDGET_CLASS_NAME);
	el.replaceChildren(createTopLevelError(new Error("NotebookCell renders only inside its parent Notebook display")));
}

function createTopLevelError(error: unknown): HTMLElement {
	const pre = document.createElement("pre");
	pre.className = ERROR_CLASS_NAME;
	pre.textContent = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	return pre;
}

export default { initialize, render };
