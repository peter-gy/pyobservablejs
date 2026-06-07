import type { InitializeProps, RenderProps } from "@anywidget/types";
import { renderNotebookWidget } from "./notebook-renderer";
import type { WidgetModel } from "./types";

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
