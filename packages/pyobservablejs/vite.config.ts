import anywidgetBundle from "@pyobservablejs/anywidget-bundle/vite";
import { defineConfig } from "vite-plus";

export default defineConfig({
	plugins: [
		anywidgetBundle({
			app: "@pyobservablejs/widget",
			outDir: "src/observablejs/static",
		}),
	],
});
