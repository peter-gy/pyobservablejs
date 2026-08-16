import type { RenderProps } from "@anywidget/types";
import { deserialize, toNotebook, type Notebook, type NotebookSpec } from "@observablehq/notebook-kit";
import {
	isBoolean,
	isCallable,
	isObjectValue,
	isString,
	type AttachmentInfo,
	type NotebookGraph,
	type NotebookOptions,
	type WireRecord,
	type WireValue,
	type WireValues,
} from "@pyobservablejs/runtime";
import { isNotebookTheme } from "./themes";

export type WidgetModel = {
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
		graph: NotebookGraph | Record<string, never>;
		results: Record<
			string,
			{
				revision: number;
				status: "pending" | "success" | "error";
				values: WireValues;
				errors: Array<{
					name: string;
					message: string;
					phase: "analysis" | "evaluation" | "rendering" | "serialization";
					variable?: string;
				}>;
			}
		>;
		errors: Array<{
			name: string;
			message: string;
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

export function readNotebookVariables(model: AnyWidgetModel): WireValues {
	return readWireValues(model.get("_variables"));
}

export function readNotebookFromModel(model: AnyWidgetModel): Notebook {
	const source = model.get("_source");
	const notebook = source?.trim() ? deserialize(source) : toNotebook(model.get("_spec") ?? {});
	const theme = readNotebookTheme(model);
	return theme === undefined ? notebook : { ...notebook, theme };
}

export function readNotebookOptions(model: AnyWidgetModel, variablesOverride?: WireValues): NotebookOptions {
	const wireOptions = model.get("_options");
	return {
		attachments: model.get("_attachments") ?? {},
		baseUrl: model.get("_base_url") || document.baseURI,
		variables: variablesOverride ?? readNotebookVariables(model),
		showSource: wireOptions?.show_source === true,
		runtimeProfile: model.get("_runtime_profile") === "observable" ? "observable" : "notebook-kit",
	};
}

function readNotebookTheme(model: AnyWidgetModel): Notebook["theme"] | undefined {
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

export function readCellKeys(model: AnyWidgetModel): string[] {
	const value = model.get("_cell_keys");
	if (!Array.isArray(value)) return [];
	return value.map((item) => (isString(item) ? item : ""));
}

export function readWireValues(value: WireValues | WireValue | undefined): WireValues {
	if (!isRecord(value)) return {};
	const values: WireValues = {};
	for (const [name, item] of Object.entries(value)) {
		if (item !== undefined) values[name] = item;
	}
	return values;
}
