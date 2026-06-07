import type { RenderProps } from "@anywidget/types";
import type { NotebookGraph } from "../observable/types";
import type { AttachmentInfo } from "../runtime/types";

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

export type WidgetAnyModel = RenderProps<WidgetModel>["model"];
