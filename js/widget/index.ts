import type { RenderProps } from "@anywidget/types";
import { loadApp } from "virtual:anywidget-bundle";
import { createObservableWidgetEntry } from "./entry";
import type { WidgetModel } from "./state";
import "./widget.css";

export default createObservableWidgetEntry((props: RenderProps<WidgetModel>, signal: AbortSignal) => {
	return loadApp<WidgetModel>(props.model, signal);
});
