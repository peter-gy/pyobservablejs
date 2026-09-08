import type { InitializeProps, RenderProps } from "@anywidget/types";
import { DiagnosticPublisher, showError } from "./errors";
import type { WidgetModel } from "./model";
import { renderNotebookViewModel } from "./view";

export default function createWidget() {
	let activeSignal: AbortSignal | undefined;
	let diagnostics: DiagnosticPublisher | undefined;

	return {
		initialize(_props: InitializeProps<WidgetModel>) {},
		render(props: RenderProps<WidgetModel>) {
			if (props.signal.aborted) return;
			if (activeSignal && !activeSignal.aborted) {
				const cause = new Error("NotebookView already has a live writable render");
				diagnostics?.report(cause, {
					phase: "rendering",
					component: "packages/widget/src/index.ts",
					operation: "render view",
				});
				diagnostics?.flush();
				showError(props.el, cause);
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
			diagnostics = new DiagnosticPublisher(props.model, props.signal, props.el);
			try {
				renderNotebookViewModel(props, diagnostics);
			} catch (cause) {
				diagnostics.report(cause, {
					phase: "rendering",
					component: "packages/widget/src/index.ts",
					operation: "initialize view",
				});
				diagnostics.flush();
				showError(props.el, cause);
			}
		},
	};
}
