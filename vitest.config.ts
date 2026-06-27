import { defineConfig } from "vitest/config";
import anywidgetBundle from "./js/anywidget-bundle/vite";

const fromRoot = (path: string) => new URL(path, import.meta.url).pathname;

export default defineConfig({
	resolve: {
		alias: {
			"@": fromRoot("./js"),
		},
	},
	plugins: [
		anywidgetBundle({
			app: "js/widget/app.ts",
			outDir: "src/observablejs/static",
		}),
	],
	test: {
		css: true,
		deps: {
			web: {
				transformCss: true,
			},
		},
	},
});
