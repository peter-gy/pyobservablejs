import type { RenderProps, ResolvedWidget } from "@anywidget/types";
import type { Cell, Notebook } from "@observablehq/notebook-kit";
import type { NotebookRuntime } from "@observablehq/notebook-kit/runtime";
import type { WidgetModel } from "../model/types";
import type { NotebookOptions, RuntimeVariablesSync, ViewTarget } from "../runtime/types";

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

export type CellRenderContext = {
	notebookModel: RenderProps<WidgetModel>["model"];
	runtime: NotebookRuntime;
	showSource: boolean;
	cell: Cell;
	cellIndex: number;
	notebook: Notebook;
	options: NotebookOptions;
	cellModels: Array<RenderProps<WidgetModel>["model"] | undefined>;
	sync: CellVariableSync;
};

export type CellExports = {
	bindRuntime(context: CellRenderContext): void;
	unbindRuntime(context: CellRenderContext): void;
	prepareComposedRender(el: HTMLElement, context: CellRenderContext): void;
};

export type ResolvedCellWidget = ResolvedWidget<CellExports>;

export type ResolvedCell = [ResolvedCellWidget, RenderProps<WidgetModel>["model"]];

export type CompositionHost = {
	getModel(ref: string): Promise<RenderProps<WidgetModel>["model"]>;
	getWidget(ref: string): Promise<ResolvedCellWidget>;
};

export type RuntimeObserver = Parameters<NotebookRuntime["main"]["variable"]>[0];
