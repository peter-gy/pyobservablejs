import type { RenderProps } from "@anywidget/types";
import { loadChunkedAnyWidgetApp } from "../anywidget/chunked-module-loader";
import { createObservableWidgetEntry } from "./entry";
import type { WidgetModel } from "./model";
import "./widget.css";

const WIDGET_APP_MODULE = "__PYOBSERVABLEJS_APP_MODULE__";

export default createObservableWidgetEntry((props: RenderProps<WidgetModel>, signal: AbortSignal) => {
	return loadChunkedAnyWidgetApp<WidgetModel>(props.model, WIDGET_APP_MODULE, signal);
});
