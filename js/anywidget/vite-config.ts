import { defineConfig, type Plugin, type UserConfig } from "vite";

type AssetInfo = {
	names?: string[];
	name?: string;
};

type ChunkedAnyWidgetViteOptions = {
	outDir: string;
	entry: string;
	appEntry: string;
	appModulePlaceholder: string;
	entryName?: string;
	appEntryName?: string;
	devHost?: string;
	devPort?: number;
	entryFileName?: string;
	appChunkPattern?: string;
	chunkFileNames?: string;
	cssFileName?: string;
	cssOutputFile?: string;
	assetFileNames?: string;
};

export function defineChunkedAnyWidgetConfig(options: ChunkedAnyWidgetViteOptions) {
	const entryName = options.entryName ?? "index";
	const appEntryName = options.appEntryName ?? "app";
	const entryFileName = options.entryFileName ?? "index.js";
	const appChunkPattern = options.appChunkPattern ?? "chunks/[name]-[hash].js";
	const chunkFileNames = options.chunkFileNames ?? "chunks/[name]-[hash].js";
	const cssFileName = options.cssFileName ?? "widget";
	const cssOutputFile = options.cssOutputFile ?? "widget.css";
	const assetFileNames = options.assetFileNames ?? "assets/[name]-[hash][extname]";

	return defineConfig(async ({ command }) => {
		const { default: anywidget } = await import("@anywidget/vite");
		return {
			define: {
				"process.env.NODE_ENV": JSON.stringify(command === "serve" ? "development" : "production"),
			},
			server: {
				host: options.devHost,
				port: options.devPort,
			},
			plugins: [anywidget(), chunkedAnyWidgetEntry(options.appModulePlaceholder, entryFileName, appEntryName)],
			build: {
				outDir: options.outDir,
				target: "esnext",
				lib: {
					entry: {
						[entryName]: options.entry,
						[appEntryName]: options.appEntry,
					},
					fileName: (_format, name) => (name === entryName ? entryFileName : appChunkPattern),
					cssFileName,
					formats: ["es"],
				},
				copyPublicDir: false,
				cssCodeSplit: false,
				emptyOutDir: true,
				rolldownOptions: {
					output: {
						chunkFileNames,
						assetFileNames: (assetInfo: AssetInfo) => {
							const name = assetInfo.names?.[0] ?? assetInfo.name ?? "";
							return name.endsWith(".css") ? cssOutputFile : assetFileNames;
						},
					},
				},
			},
		} satisfies UserConfig;
	});
}

function chunkedAnyWidgetEntry(placeholder: string, entryFileName: string, appEntryName: string): Plugin {
	return {
		name: "chunked-anywidget-entry",
		apply: "build",
		generateBundle(_options, bundle) {
			let appModule: string | undefined;
			let entryModule: { code: string } | undefined;

			for (const item of Object.values(bundle)) {
				if (item.type !== "chunk") continue;
				if (item.name === appEntryName) appModule = item.fileName;
				if (item.fileName === entryFileName) entryModule = item;
			}

			if (!appModule) this.error("Could not find the anywidget app chunk.");
			if (!entryModule) this.error("Could not find the anywidget entry module.");
			if (!entryModule.code.includes(placeholder)) {
				this.error("The anywidget entry module does not reference the app chunk placeholder.");
			}

			entryModule.code = entryModule.code.split(placeholder).join(appModule);
		},
	};
}
