import type { RenderProps } from "@anywidget/types";
import { deserialize, toNotebook, type Notebook } from "@observablehq/notebook-kit";
import type { NotebookGraph } from "../notebook/graph";
import type { AttachmentInfo, NotebookOptions } from "../runtime";

// Trait names match src/pyobservablejs/_notebook.py, including underscored wire traits.
export type WidgetModel = {
	role?: "notebook" | "cell";
	name?: string;
	source?: string;
	spec?: Record<string, unknown>;
	attachments?: Record<string, AttachmentInfo>;
	base_url?: string;
	_variables?: Record<string, unknown>;
	_variable_update?: {
		seq?: number;
		kind?: "set" | "replace";
		values?: Record<string, unknown>;
	};
	_esm_module_request?: {
		seq?: number;
		path?: string;
	};
	_esm_module_response?: {
		seq?: number;
		path?: string;
		source?: string;
		error?: string;
	};
	_graph?: NotebookGraph;
	_values?: Record<string, unknown>;
	_value_names?: string[];
	options?: {
		show_source?: boolean;
	};
	_cell_widgets?: string[];
};

export type AnyWidgetModel = RenderProps<WidgetModel>["model"];

export type { NotebookGraph } from "../notebook/graph";

export const NOTEBOOK_MODEL_CHANGE_EVENTS = [
	"change:source",
	"change:spec",
	"change:attachments",
	"change:base_url",
	"change:options",
	"change:_cell_widgets",
] as const;

export function readModelVariableNames(model: AnyWidgetModel): string[] {
	const value = model.get("_value_names");
	return Array.isArray(value) ? value.filter((name): name is string => typeof name === "string") : [];
}

export function readModelVariables(model: AnyWidgetModel): Record<string, unknown> {
	const value = model.get("_values");
	if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
	return value;
}

export function readNotebookVariables(model: AnyWidgetModel): Record<string, unknown> {
	const value = model.get("_variables");
	if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
	return value;
}

/**
 * Read the current notebook from the model traitlets.
 *
 * Serialized source wins over `spec` because hosted Observable notebooks carry
 * OJS cell modes and import metadata that `spec` does not always preserve.
 */
export function readNotebookFromModel(model: RenderProps<WidgetModel>["model"]): Notebook {
	const source = model.get("source");
	if (source?.trim()) return deserialize(source);
	return toNotebook(model.get("spec") ?? {});
}

/**
 * Build runtime options from model traitlets for the current render attempt.
 */
export function readNotebookOptions(
	model: RenderProps<WidgetModel>["model"],
	variablesOverride?: Record<string, unknown>,
): NotebookOptions {
	const wireOptions = model.get("options");
	return {
		attachments: model.get("attachments") ?? {},
		baseUrl: model.get("base_url") || document.baseURI,
		variables: variablesOverride ?? readNotebookVariables(model),
		showSource: wireOptions?.show_source === true,
	};
}

/**
 * Return only well-formed anywidget references from the cell reference trait.
 */
export function readCellRefs(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}
