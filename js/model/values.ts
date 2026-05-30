import type { RenderProps } from "@anywidget/types";
import type { WidgetModel } from "./types";

export type AnyWidgetModel = RenderProps<WidgetModel>["model"];

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
