import type { RenderProps } from "@anywidget/types";
import type { Cell, Notebook } from "@observablehq/notebook-kit";
import type { NotebookRuntime } from "@observablehq/notebook-kit/runtime";

// These types describe the anywidget trait contract shared with Python. The
// names match trait names in src/observablejs/_notebook.py, including the
// leading underscores on private wire traits.

export type AttachmentInfo = {
	url: string;
	mimeType?: string;
	lastModified?: number;
	size?: number;
};

export type WidgetModel = {
	role?: "notebook" | "cell";
	name?: string;
	// Source-backed notebooks keep the original Notebook Kit HTML here.
	source?: string;
	// Python-authored notebooks send Notebook Kit's JSON notebook shape here.
	spec?: Record<string, unknown>;
	attachments?: Record<string, AttachmentInfo>;
	base_url?: string;
	// Serialized Python data. runtime.ts revives this as Observable builtins.
	_data?: Record<string, unknown>;
	// Notebook-level symbolic graph derived from Notebook Kit transpilation.
	_graph?: NotebookGraph;
	// Browser-produced cell values mirrored back to the matching Python child.
	variables?: Record<string, unknown>;
	variable_names?: string[];
	options?: {
		show_source?: boolean;
	};
	// anywidget references for one child model per Notebook Kit cell.
	_cell_widgets?: string[];
};

export type NotebookOptions = {
	attachments: Record<string, AttachmentInfo>;
	baseUrl: string;
	data: Record<string, unknown>;
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
	// OJS viewof cells expose DOM-ish targets; Python value updates write back
	// into those targets so the rendered control and synced trait stay aligned.
	views: Map<string, ViewTarget>;
	setVariableNames(names: string[]): void;
	setVariable(name: string, value: unknown): void;
	currentVariables(): Record<string, unknown>;
};

export type ViewTarget = EventTarget & {
	value?: unknown;
	checked?: boolean;
};

export type CellRenderContext = {
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
	renderComposed(el: HTMLElement, signal: AbortSignal, context?: CellRenderContext): void;
};

export type ResolvedCellWidget = {
	exports: CellExports;
};

export type ResolvedCell = [ResolvedCellWidget, RenderProps<WidgetModel>["model"]];

export type CompositionHost = {
	getModel(ref: string): Promise<RenderProps<WidgetModel>["model"]>;
	getWidget(ref: string): Promise<ResolvedCellWidget>;
};

export type WidgetManager = {
	get_model?: (id: string) => Promise<RenderProps<WidgetModel>["model"]> | RenderProps<WidgetModel>["model"];
	getModel?: (id: string) => Promise<RenderProps<WidgetModel>["model"]> | RenderProps<WidgetModel>["model"];
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
	name: string;
};

export type NotebookGraph = {
	cells: CellGraph[];
	edges: GraphEdge[];
};
