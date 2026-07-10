import type { RenderProps } from "@anywidget/types";
import type { WidgetModel } from "./model";

type AnyWidgetModel = RenderProps<WidgetModel>["model"];

export type NotebookCompositionState = {
	cellKeys: string[];
	cellRefs: string[];
};

export type CellCompositionState = {
	parentRef: string;
	index: number;
};

export function readNotebookCompositionState(model: AnyWidgetModel): NotebookCompositionState {
	return {
		cellKeys: readCellKeys(model),
		cellRefs: readCellRefs(model.get("_cell_widgets")),
	};
}

export function readCellCompositionState(model: AnyWidgetModel): CellCompositionState {
	const parentRef = model.get("_notebook_widget");
	if (typeof parentRef !== "string" || !parentRef) {
		throw new Error("NotebookCell has no parent Notebook reference");
	}
	const index = model.get("_notebook_index");
	if (!Number.isInteger(index) || (index as number) < 0) {
		throw new Error("NotebookCell has no parent Notebook index");
	}
	return { parentRef, index: index as number };
}

function readCellRefs(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

function readCellKeys(model: AnyWidgetModel): string[] {
	const value = model.get("_cell_keys");
	if (!Array.isArray(value)) return [];
	return value.map((item) => (typeof item === "string" ? item : ""));
}
