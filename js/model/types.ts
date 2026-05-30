import type { RenderProps } from "@anywidget/types";
import type { NotebookGraph } from "../observable/types";
import type { AttachmentInfo } from "../runtime/types";

// Trait names match src/pyobservablejs/_notebook.py, including underscored wire traits.

export type WidgetModel = {
	role?: "notebook" | "cell";
	_cell_id?: string;
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
	_graph?: NotebookGraph;
	_values?: Record<string, unknown>;
	_value_names?: string[];
	options?: {
		show_source?: boolean;
		observable_markdown_compatibility?: boolean;
	};
	_cell_widgets?: string[];
};

export type WidgetAnyModel = RenderProps<WidgetModel>["model"];
