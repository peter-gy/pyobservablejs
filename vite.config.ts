import { defineConfig } from "vite";
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
			entry: "js/widget/index.ts",
			app: "js/widget/app.ts",
			outDir: "src/observablejs/static",
			dev: { host: "127.0.0.1", port: 5173 },
			output: { entryFile: "index.js" },
		}),
	],
});
