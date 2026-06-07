import type { InitializeProps, RenderProps } from "@anywidget/types";
import { loadWidgetApp } from "./module-loader";
import type { WidgetModel } from "./types";
import "./widget.css";

const WIDGET_APP_MODULE = "__PYOBSERVABLEJS_APP_MODULE__";
const WIDGET_CLASS_NAME = "pyobservablejs";
const ERROR_CLASS_NAME = "pyobservablejs-error";

function initialize(props: InitializeProps<WidgetModel> & { signal?: AbortSignal }): void {
	void props;
}

function render(props: RenderProps<WidgetModel> & { signal?: AbortSignal }): void {
	const signal = props.signal ?? new AbortController().signal;
	if (signal.aborted) return;
	if (props.model.get("role") === "cell") {
		renderCellWidget(props.el, signal);
		return;
	}
	void renderNotebook(props, signal);
}

async function renderNotebook(props: RenderProps<WidgetModel>, signal: AbortSignal): Promise<void> {
	try {
		if (signal.aborted) return;
		const app = await loadWidgetApp(props.model, WIDGET_APP_MODULE, signal, { invoke: props.experimental?.invoke });
		if (signal.aborted) return;
		await app.render({ ...props, signal });
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
