import type { RenderProps } from "@anywidget/types";
import type { NotebookRuntime } from "@observablehq/notebook-kit/runtime";
import type { WidgetModel } from "../model/types";
import type { RuntimeVariablesSync, ViewTarget } from "../runtime/types";

export type { WidgetModel } from "../model/types";
export type { NotebookGraph } from "../observable/types";
export type { NotebookOptions, RuntimeVariablesSync, ViewTarget } from "../runtime/types";

export type CellVariableSync = {
	model: RenderProps<WidgetModel>["model"];
	signal: AbortSignal;
	variablesSync?: RuntimeVariablesSync;
	views: Map<string, ViewTarget>;
	viewCleanups: Map<string, () => void>;
	setVariableNames(names: string[]): void;
	setVariable(name: string, value: unknown): void;
	currentVariables(): Record<string, unknown>;
};

export type CompositionHost = {
	getModel(ref: string, signal?: AbortSignal): Promise<RenderProps<WidgetModel>["model"] | undefined>;
};

export type RuntimeObserver = Parameters<NotebookRuntime["main"]["variable"]>[0];
