import type { RenderProps } from "@anywidget/types";
import { deserialize, toNotebook, type Notebook } from "@observablehq/notebook-kit";
import { readNotebookVariables } from "../model/values";
import type { WidgetModel } from "../model/types";
import type { NotebookOptions } from "../runtime/types";

export const NOTEBOOK_MODEL_CHANGE_EVENTS = [
	"change:source",
	"change:spec",
	"change:attachments",
	"change:base_url",
	"change:options",
	"change:_cell_widgets",
] as const;

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
