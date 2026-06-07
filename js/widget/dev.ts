import app from "./app";
import { createObservableWidgetEntry } from "./entry";
import "./widget.css";

export default createObservableWidgetEntry(() => app);
