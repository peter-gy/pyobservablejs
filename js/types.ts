import type { RenderProps, ResolvedWidget } from "@anywidget/types";
import type { Cell, Notebook } from "@observablehq/notebook-kit";
import type { NotebookRuntime } from "@observablehq/notebook-kit/runtime";

// Trait names match src/observablejs/_notebook.py, including underscored wire traits.

export type AttachmentInfo = {
	url: string;
	mimeType?: string;
	lastModified?: number;
	size?: number;
};

export type WidgetModel = {
	role?: "notebook" | "cell";
	// Stable per-cell lifecycle key shared by anywidget initialize/render model proxies.
	_cell_id?: string;
	name?: string;
	source?: string;
	spec?: Record<string, unknown>;
	attachments?: Record<string, AttachmentInfo>;
	base_url?: string;
	// Serialized Python-owned Observable variables. runtime.ts revives this as Observable builtins.
	_variables?: Record<string, unknown>;
	_variable_update?: {
		seq?: number;
		kind?: "set" | "replace";
		values?: Record<string, unknown>;
	};
	_graph?: NotebookGraph;
	// Browser-produced values. Notebook models aggregate child cell values.
	// Cell models hold values for their matching cell.
	_values?: Record<string, unknown>;
	_value_names?: string[];
	options?: {
		show_source?: boolean;
	};
	// anywidget references for one child model per Notebook Kit cell.
	_cell_widgets?: string[];
};

export type NotebookOptions = {
	attachments: Record<string, AttachmentInfo>;
	baseUrl: string;
	variables: Record<string, unknown>;
	showSource: boolean;
};

export type AttachmentRegistry = {
	baseUrl: string;
	names: Set<string>;
	cleanup(): void;
};

export type CellVariableSync = {
	model: RenderProps<WidgetModel>["model"];
	signal: AbortSignal;
	variablesSync?: RuntimeVariablesSync;
	// OJS viewof cells expose DOM-ish targets. Python value updates write back
	// into those targets so the rendered control and synced trait stay aligned.
	views: Map<string, ViewTarget>;
	viewCleanups: Map<string, () => void>;
	setVariableNames(names: string[]): void;
	setVariable(name: string, value: unknown): void;
	currentVariables(): Record<string, unknown>;
};

export type RuntimeVariablesSync = {
	applyInitialViews(): void;
	setView(name: string, view: ViewTarget): void;
	deleteView(name: string, view: ViewTarget): void;
};

export type ViewTarget = EventTarget & {
	value?: unknown;
	checked?: boolean;
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

export type CellGraph = {
	id: number;
	index: number;
	name: string;
	mode: Cell["mode"];
	defines: string[];
	references: string[];
	output: string | null;
	outputs: string[];
	runtime_outputs: string[];
	autodisplay: boolean;
	autoview: boolean;
	automutable: boolean;
	error?: string;
};

export type GraphEdge = {
	from: number;
	to: number;
	variable: string;
};

export type NotebookGraph = {
	cells: CellGraph[];
	edges: GraphEdge[];
};
