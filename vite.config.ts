import { defineChunkedAnyWidgetConfig } from "./js/anywidget/vite-config";

const WIDGET_STATIC_DIR = "src/pyobservablejs/static";
const WIDGET_ENTRY = "js/widget/index.ts";
const WIDGET_APP_ENTRY = "js/widget/app.ts";
const WIDGET_APP_MODULE_PLACEHOLDER = "__PYOBSERVABLEJS_APP_MODULE__";
const WIDGET_DEV_HOST = "127.0.0.1";
const WIDGET_DEV_PORT = 5173;

const WIDGET_BUILD = {
	outDir: WIDGET_STATIC_DIR,
	entry: WIDGET_ENTRY,
	appEntry: WIDGET_APP_ENTRY,
	appModulePlaceholder: WIDGET_APP_MODULE_PLACEHOLDER,
	devHost: WIDGET_DEV_HOST,
	devPort: WIDGET_DEV_PORT,
} as const;

export default defineChunkedAnyWidgetConfig(WIDGET_BUILD);
