import type { RenderProps } from "@anywidget/types";
import type { Notebook } from "@observablehq/notebook-kit";
import type { NotebookRuntime } from "@observablehq/notebook-kit/runtime";
import {
	createRuntimeSession,
	notebookViewNamesFromAnalysis,
	type NotebookAnalysis,
	type NotebookOptions,
	type RuntimeVariablesSync,
} from "@/runtime";
import { createNotebookRoot, prepareWidgetShell } from "./dom";
import { readNotebookOptions, type WidgetModel } from "./model";
import { installNotebookThemeStyles } from "./themes";
import { createRuntimeVariablesSync, writeProgrammaticViewValue } from "./variable-sync";

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
	signal: AbortSignal;
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

	const controller = new AbortController();
	const sessionSignal = AbortSignal.any([signal, controller.signal]);
	const root = createNotebookRoot(el, notebook.theme);
	const options = readNotebookOptions(model, variablesOverride);
	const core = createRuntimeSession(root, el, options);
	const runtime = core.runtime;
	let disposed = false;
	const cleanup = () => {
		if (disposed) return;
		disposed = true;
		signal.removeEventListener("abort", cleanup);
		controller.abort();
		core.dispose();
	};
	try {
		const variablesSync = createRuntimeVariablesSync({
			model,
			runtime,
			options,
			viewNames: notebookViewNamesFromAnalysis(analysis),
			signal: sessionSignal,
			onReset: onInputReset,
			writeViewValue: writeProgrammaticViewValue,
		});
		signal.addEventListener("abort", cleanup, { once: true });
		return { root, runtime, options, variablesSync, signal: sessionSignal, cleanup };
	} catch (error) {
		cleanup();
		throw error;
	}
}
