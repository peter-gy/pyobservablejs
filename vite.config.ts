import { defineConfig, type Plugin } from "vite";

const WIDGET_APP_MODULE_PLACEHOLDER = "__PYOBSERVABLEJS_APP_MODULE__";

function pyobservablejsAnywidgetEntry(): Plugin {
	return {
		name: "pyobservablejs-anywidget-entry",
		generateBundle(_options, bundle) {
			let appModule: string | undefined;
			let indexModule: { code: string } | undefined;

			for (const item of Object.values(bundle)) {
				if (item.type !== "chunk") continue;
				if (item.name === "app") appModule = item.fileName;
				if (item.fileName === "index.js") indexModule = item;
			}

			if (!appModule) this.error("Could not find the widget app chunk.");
			if (!indexModule) this.error("Could not find the anywidget entry module.");
			if (!indexModule.code.includes(WIDGET_APP_MODULE_PLACEHOLDER)) {
				this.error("The anywidget entry module does not reference the widget app chunk placeholder.");
			}

			indexModule.code = indexModule.code.split(WIDGET_APP_MODULE_PLACEHOLDER).join(appModule);
		},
	};
}

function manualChunks(id: string): string | undefined {
	const normalized = id.split("\\").join("/");
	if (normalized.includes("@observablehq/notebook-kit/dist/src/runtime/stdlib/fileAttachment.js")) {
		return "observablehq-notebook-kit-file";
	}
	if (normalized.includes("@observablehq/notebook-kit/dist/src/runtime/stdlib/zip.js")) {
		return "observablehq-notebook-kit-file";
	}
	return undefined;
}

export default defineConfig({
	define: {
		"process.env.NODE_ENV": JSON.stringify("production"),
	},
	plugins: [pyobservablejsAnywidgetEntry()],
	build: {
		outDir: "src/pyobservablejs/static",
		target: "esnext",
		lib: {
			entry: {
				index: "js/widget/index.ts",
				app: "js/widget/app.ts",
			},
			fileName: (_format, entryName) => (entryName === "index" ? "index.js" : `chunks/${entryName}-[hash].js`),
			cssFileName: "widget",
			formats: ["es"],
		},
		copyPublicDir: false,
		cssCodeSplit: false,
		emptyOutDir: true,
		rolldownOptions: {
			output: {
				manualChunks,
				chunkFileNames: "chunks/[name]-[hash].js",
				assetFileNames: (assetInfo) => {
					const name = assetInfo.names[0] ?? "";
					return name.endsWith(".css") ? "widget.css" : "assets/[name]-[hash][extname]";
				},
			},
		},
	},
});
