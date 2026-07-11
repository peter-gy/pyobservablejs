import type { RenderProps } from "@anywidget/types";
import type { WidgetModel } from "./model";

type AnyWidgetModel = RenderProps<WidgetModel>["model"];

export type CellCompositionState = {
	parentRef: string;
	index: number;
};

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

export function readCellKeys(model: AnyWidgetModel): string[] {
	const value = model.get("_cell_keys");
	if (!Array.isArray(value)) return [];
	return value.map((item) => (typeof item === "string" ? item : ""));
}
