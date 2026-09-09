import { isBoolean, isCallable, isObjectValue, isString } from "@pyobservablejs/runtime/values";
import type { RenderProps } from "@anywidget/types";
import {
	NOTEBOOK_THEMES,
	type AttachmentInfo,
	type CellGraph,
	type GraphEdge,
	type NotebookInspection,
	type Diagnostic,
	type ErrorDetail,
	type DatasetInfo,
	type MountOptions,
	type NotebookSpec,
	type Variables,
} from "@pyobservablejs/runtime";
import { revivePythonValue, type WireRecord, type WireValue, type WireValues } from "./values";

export type WireNotebookGraph = {
	cells: Array<Omit<CellGraph, "runtimeOutputs"> & { runtime_outputs: readonly string[] }>;
	edges: readonly GraphEdge[];
};

export type WireDiagnostics = { revision: number; sequence: number; errors: readonly Diagnostic[] };

export type WidgetModel = {
	_diagnostics?: WireDiagnostics | Record<string, never>;
	_inspection?: { generation: string; value: NotebookInspection | null } | Record<string, never>;
	_datasets?: { generation: string; values: readonly DatasetInfo[] } | Record<string, never>;
	_model_role?: "session";
	_runtime_profile?: "notebook-kit" | "observable";
	_session?: string | null;
	_cell_indexes?: number[] | null;
	_capture_state?: WireValue;
	_source?: string;
	_spec?: NotebookSpec;
	theme?: WireValue;
	_attachments?: Record<string, AttachmentInfo>;
	_base_url?: string;
	_variables?: WireValues;
	_view_values?: WireValues;
	_variable_update?: {
		seq?: number;
		kind?: "set" | "replace";
		values?: WireValues;
	};
	_readback?: {
		revision: number;
		input_revision: number | null;
		settled_revision: number | null;
		pending: boolean;
		graph: WireNotebookGraph | Record<string, never>;
		results: Record<
			string,
			{
				revision: number;
				status: "pending" | "success" | "error";
				values: WireValues;
				errors: Array<{
					name: string;
					message: string;
					stack?: string;
					cause?: ErrorDetail;
					phase: "analysis" | "evaluation" | "rendering" | "serialization";
					variable?: string;
				}>;
			}
		>;
		errors: Array<{
			name: string;
			message: string;
			stack?: string;
			cause?: ErrorDetail;
			phase: "analysis" | "evaluation" | "rendering" | "serialization";
		}>;
	};
	_options?: {
		show_source?: boolean;
	};
	_cell_keys?: string[];
};

export type AnyWidgetModel = RenderProps<WidgetModel>["model"];

export const SESSION_MODEL_CHANGE_EVENTS = [
	"change:_source",
	"change:_spec",
	"change:theme",
	"change:_attachments",
	"change:_base_url",
	"change:_runtime_profile",
	"change:_options",
	"change:_cell_keys",
] as const;

export const VIEW_MODEL_CHANGE_EVENTS = ["change:_session", "change:_cell_indexes"] as const;

export function isRecord<Value>(value: Value): value is Value & WireRecord {
	return isObjectValue(value) && !isCallable(value) && !Array.isArray(value);
}

export function readCaptureState(model: AnyWidgetModel): boolean {
	const value = model.get("_capture_state");
	if (value === undefined) return true;
	if (!isBoolean(value)) throw new Error("NotebookView capture state must be a boolean");
	return value;
}

function readNotebookVariables(model: AnyWidgetModel): WireValues {
	return readWireValues(model.get("_variables"));
}

export function readNotebookSource(model: AnyWidgetModel): string | NotebookSpec {
	const source = model.get("_source");
	return source?.trim() ? source : (model.get("_spec") ?? {});
}

export function decodeVariables(values: WireValues): Variables {
	return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, revivePythonValue(value)]));
}

export function readNotebookOptions(model: AnyWidgetModel): MountOptions {
	return {
		attachments: model.get("_attachments") ?? {},
		baseUrl: model.get("_base_url") || undefined,
		variables: decodeVariables(readNotebookVariables(model)),
		showSource: model.get("_options")?.show_source === true,
		runtimeProfile: model.get("_runtime_profile") === "observable" ? "observable" : "notebook-kit",
		theme: readNotebookTheme(model),
		keys: readCellKeys(model),
	};
}

function isNotebookTheme<Value>(value: Value): value is Value & (typeof NOTEBOOK_THEMES)[number] {
	return isString(value) && NOTEBOOK_THEMES.some((theme) => theme === value);
}

function readNotebookTheme(model: AnyWidgetModel): MountOptions["theme"] {
	const theme = model.get("theme");
	if (isNotebookTheme(theme)) return theme;
	if (!isRecord(theme)) return undefined;
	const light = theme.light;
	const dark = theme.dark;
	if (isNotebookTheme(light) && isNotebookTheme(dark)) return { light, dark };
	return undefined;
}

export function readNotebookSessionRef(model: AnyWidgetModel): string {
	const sessionRef = model.get("_session");
	if (!isString(sessionRef) || !sessionRef) {
		throw new Error("NotebookView has no Notebook session reference");
	}
	return sessionRef;
}

export function readSelectedCellIndexes(model: AnyWidgetModel): Set<number> | null {
	const rawIndexes = model.get("_cell_indexes");
	if (rawIndexes === null) return null;
	if (!Array.isArray(rawIndexes)) throw new Error("NotebookView cell indexes must be an array or null");
	if (rawIndexes.length === 0) throw new Error("NotebookView cell indexes must not be empty");
	const indexes = new Set<number>();
	for (const value of rawIndexes) {
		if (!Number.isInteger(value) || value < 0) {
			throw new Error("NotebookView cell indexes must be non-negative integers");
		}
		if (indexes.has(value)) throw new Error("NotebookView cell indexes must be unique");
		indexes.add(value);
	}
	return indexes;
}

function readCellKeys(model: AnyWidgetModel): string[] {
	const value = model.get("_cell_keys");
	if (!Array.isArray(value)) return [];
	return value.map((item) => (isString(item) ? item : ""));
}

export function readWireValues(value: WireValues | WireValue | undefined): WireValues {
	if (!isRecord(value)) return {};
	return Object.fromEntries(
		Object.entries(value).filter((entry): entry is [string, WireValue] => entry[1] !== undefined),
	);
}
