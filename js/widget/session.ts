import type { RenderProps } from "@anywidget/types";
import type { Notebook } from "@observablehq/notebook-kit";
import type { NotebookRuntime } from "@observablehq/notebook-kit/runtime";
import { notebookViewNamesFromAnalysis, type NotebookAnalysis } from "@/runtime/graph";
import {
	createRuntime,
	createRuntimeCleanup,
	registerAttachments,
	type NotebookOptions,
	type RuntimeVariablesSync,
} from "@/runtime";
import { createNotebookRoot, prepareWidgetShell } from "./dom";
import { createRuntimeVariablesSync, readNotebookOptions, writeProgrammaticViewValue, type WidgetModel } from "./state";
import { installNotebookThemeStyles } from "./themes";

type AnyWidgetModel = RenderProps<WidgetModel>["model"];

type NotebookRuntimeSessionOptions = {
	model: AnyWidgetModel;
	el: HTMLElement;
	notebook: Notebook;
	analysis: NotebookAnalysis;
	signal: AbortSignal;
	onInputReset(variables: Record<string, unknown>): void;
	variablesOverride?: Record<string, unknown>;
};

export type NotebookRuntimeSession = {
	root: HTMLElement;
	runtime: NotebookRuntime;
	options: NotebookOptions;
	variablesSync: RuntimeVariablesSync;
	cleanup(): void;
};

export function openNotebookRuntimeSession({
	model,
	el,
	notebook,
	analysis,
	signal,
	onInputReset,
	variablesOverride,
}: NotebookRuntimeSessionOptions): NotebookRuntimeSession | undefined {
	prepareWidgetShell(el);
	const ownerRoot = el.getRootNode();
	installNotebookThemeStyles(ownerRoot instanceof ShadowRoot ? ownerRoot : el.ownerDocument);
	if (signal.aborted) return undefined;

	const root = createNotebookRoot(el, notebook.theme);
	const options = readNotebookOptions(model, variablesOverride);
	const attachmentRegistry = registerAttachments(options.attachments);
	let runtime: NotebookRuntime;
	try {
		runtime = createRuntime(root, el, options, attachmentRegistry);
	} catch (error) {
		attachmentRegistry.cleanup();
		throw error;
	}
	const cleanup = createRuntimeCleanup(runtime, attachmentRegistry);
	const variablesSync = createRuntimeVariablesSync({
		model,
		runtime,
		options,
		viewNames: notebookViewNamesFromAnalysis(analysis),
		signal,
		onReset: onInputReset,
		writeViewValue: writeProgrammaticViewValue,
	});
	signal.addEventListener("abort", cleanup, { once: true });
	return { root, runtime, options, variablesSync, cleanup };
}
