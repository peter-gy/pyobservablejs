import "./styles/widget.css";

import type { InitializeProps, RenderProps } from "@anywidget/types";
import { createTopLevelError } from "./dom";
import type { WidgetModel } from "./model";
import { renderNotebookViewModel } from "./view";

export default function createWidget() {
	let activeSignal: AbortSignal | undefined;

	return {
		initialize(_props: InitializeProps<WidgetModel>) {},
		render(props: RenderProps<WidgetModel>) {
			if (props.signal.aborted) return;
			if (activeSignal && !activeSignal.aborted) {
				props.el.replaceChildren(createTopLevelError(new Error("NotebookView already has a live writable render")));
				return;
			}
			activeSignal = props.signal;
			props.signal.addEventListener(
				"abort",
				() => {
					if (activeSignal === props.signal) activeSignal = undefined;
				},
				{ once: true },
			);
			renderNotebookViewModel(props);
		},
	};
}
