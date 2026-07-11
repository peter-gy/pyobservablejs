import type { RenderProps } from "@anywidget/types";
import { deserialize, toNotebook, type Notebook } from "@observablehq/notebook-kit";
import type { AttachmentInfo, NotebookGraph, NotebookOptions } from "@pyobservablejs/runtime";

export type WidgetModel = {
	role?: "notebook" | "cell";
	key?: string;
	name?: string;
	_notebook_widget?: string | null;
	_notebook_index?: number;
	_source?: string;
	_spec?: Record<string, unknown>;
	theme?: unknown;
	_attachments?: Record<string, AttachmentInfo>;
	_base_url?: string;
	_variables?: Record<string, unknown>;
	_variable_update?: {
		seq?: number;
		kind?: "set" | "replace";
		values?: Record<string, unknown>;
	};
	_graph?: NotebookGraph;
	_has_rendered?: boolean;
	_cell_values?: Record<
		string,
		{
			rendered?: boolean;
			names?: string[];
			values?: Record<string, unknown>;
		}
	>;
	_options?: {
		runtime_compatibility?: {
			display_view?: boolean;
			generators?: boolean;
			html?: boolean;
			mutable?: boolean;
			require?: boolean;
		};
		show_source?: boolean;
	};
	_cell_keys?: string[];
};

export type AnyWidgetModel = RenderProps<WidgetModel>["model"];

export const NOTEBOOK_MODEL_CHANGE_EVENTS = [
	"change:_source",
	"change:_spec",
	"change:theme",
	"change:_attachments",
	"change:_base_url",
	"change:_options",
	"change:_cell_keys",
] as const;

export function readNotebookVariables(model: AnyWidgetModel): Record<string, unknown> {
	const value = model.get("_variables");
	if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
	return value;
}

export function readNotebookFromModel(model: AnyWidgetModel): Notebook {
	const source = model.get("_source");
	const notebook = source?.trim() ? deserialize(source) : toNotebook(model.get("_spec") ?? {});
	const theme = readNotebookTheme(model);
	return theme === undefined ? notebook : { ...notebook, theme };
}

export function readNotebookOptions(
	model: AnyWidgetModel,
	variablesOverride?: Record<string, unknown>,
): NotebookOptions {
	const wireOptions = model.get("_options");
	return {
		attachments: model.get("_attachments") ?? {},
		baseUrl: model.get("_base_url") || document.baseURI,
		variables: variablesOverride ?? readNotebookVariables(model),
		showSource: wireOptions?.show_source === true,
		runtimeCompatibility: readRuntimeCompatibilityOptions(wireOptions),
	};
}

function readNotebookTheme(model: AnyWidgetModel): Notebook["theme"] | undefined {
	const theme = model.get("theme");
	if (typeof theme === "string") return theme as Notebook["theme"];
	if (theme === null || typeof theme !== "object" || Array.isArray(theme)) return undefined;
	const light = (theme as Record<string, unknown>).light;
	const dark = (theme as Record<string, unknown>).dark;
	if (typeof light === "string" && typeof dark === "string") return { light, dark } as Notebook["theme"];
	return undefined;
}

function readRuntimeCompatibilityOptions(options: WidgetModel["_options"]): NotebookOptions["runtimeCompatibility"] {
	const compatibility = options?.runtime_compatibility;
	if (compatibility === null || typeof compatibility !== "object" || Array.isArray(compatibility)) return {};
	return {
		displayView: compatibility.display_view === true,
		generators: compatibility.generators === true,
		html: compatibility.html === true,
		mutable: compatibility.mutable === true,
		require: compatibility.require === true,
	};
}
