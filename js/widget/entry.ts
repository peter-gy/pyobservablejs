import type { InitializeProps, RenderProps } from "@anywidget/types";
import type { AnyWidgetApp } from "@/anywidget-bundle/runtime";
import type { WidgetModel } from "./state";

const WIDGET_CLASS_NAME = "pyobservablejs";
const ERROR_CLASS_NAME = "pyobservablejs-error";

type WidgetApp = AnyWidgetApp<WidgetModel>;
type LoadApp = (props: RenderProps<WidgetModel>, signal: AbortSignal) => WidgetApp | Promise<WidgetApp>;

export function createObservableWidgetEntry(loadApp: LoadApp): WidgetApp {
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
			const app = await loadApp(props, signal);
			if (signal.aborted) return;
			await app.render({ ...props, signal });
		} catch (error) {
			if (!signal.aborted) props.el.replaceChildren(createTopLevelError(error));
		}
	}

	return { initialize, render };
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
