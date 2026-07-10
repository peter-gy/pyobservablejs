import { createAnyWidgetBundleEntry } from "./entry.ts";
import { loadAnyWidgetBundleApp } from "./runtime.ts";

// Vite replaces this token with the manifest app path. The entry is embedded in
// the widget while the app graph is fetched through Python's module handler.
declare const __ANYWIDGET_BUNDLE_APP_MODULE__: string;

export default createAnyWidgetBundleEntry((model, signal) =>
	loadAnyWidgetBundleApp(model, __ANYWIDGET_BUNDLE_APP_MODULE__, signal),
);
