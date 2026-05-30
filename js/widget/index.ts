import type { InitializeProps, RenderProps } from "@anywidget/types";
import { initializeCellWidget, renderCellWidget } from "./cell-registry";
import { renderNotebookWidget } from "./notebook-renderer";
import type { WidgetModel } from "./types";
import "@observablehq/notebook-kit/index.css";
import "@observablehq/notebook-kit/theme-air.css";
import "./styles.css";

/**
 * Expose child-cell lifecycle hooks to anywidget composition.
 */
function initialize(props: InitializeProps<WidgetModel> & { signal?: AbortSignal }) {
	return initializeCellWidget(props);
}

/**
 * Dispatch notebook and child-cell render requests to their owning modules.
 */
function render(props: RenderProps<WidgetModel> & { signal?: AbortSignal }): void {
	const signal = props.signal ?? new AbortController().signal;
	if (signal.aborted) return;
	if (props.model.get("role") === "cell") {
		renderCellWidget(props.model, props.el, signal);
		return;
	}
	renderNotebookWidget({
		model: props.model,
		el: props.el,
		signal,
		host: props.host,
		renderChildWidget: render,
	});
}

export default { initialize, render };
