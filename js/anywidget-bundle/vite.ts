import { normalizePath, type Plugin, type UserConfig } from "vite";

export type AnyWidgetBundlePluginOptions = {
	app: string;
	outDir: string;
	entry?: string;
	dev?: {
		host?: string;
		port?: number;
	};
	output?: {
		entryFile?: string;
		cssFile?: string;
		moduleDir?: string;
		appFile?: string;
		chunkFileNames?: string;
		assetFileNames?: string;
	};
};

type AssetInfo = {
	names?: string[];
	name?: string;
};

const VIRTUAL_MODULE_ID = "virtual:anywidget-bundle";
const RESOLVED_VIRTUAL_MODULE_ID = "\0virtual:anywidget-bundle";
const VIRTUAL_ENTRY_ID = "virtual:anywidget-bundle/entry?anywidget";
const RESOLVED_VIRTUAL_ENTRY_ID = "\0virtual:anywidget-bundle/entry?anywidget";
const DEV_ENTRY_ID = "/@anywidget-bundle/entry";
const DEV_ENTRY_WIDGET_ID = `${DEV_ENTRY_ID}?anywidget`;
const APP_MODULE_PLACEHOLDER = "__ANYWIDGET_BUNDLE_APP_MODULE__";
const ENTRY_NAME = "index";
const APP_ENTRY_NAME = "app";

export default function anywidgetBundle(options: AnyWidgetBundlePluginOptions): Plugin {
	const output = outputOptions(options);
	return anywidgetBundlePlugin(options, output);
}

function anywidgetBundlePlugin(
	options: AnyWidgetBundlePluginOptions,
	output: Required<NonNullable<AnyWidgetBundlePluginOptions["output"]>>,
): Plugin {
	let command: "build" | "serve" = "build";

	return {
		name: "anywidget-bundle",
		async config(_config, env) {
			const { default: anywidget } = await import("@anywidget/vite");
			command = env.command;
			return {
				define: {
					"process.env.NODE_ENV": JSON.stringify(command === "serve" ? "development" : "production"),
				},
				plugins: [anywidget()],
				server: {
					host: options.dev?.host,
					port: options.dev?.port,
				},
				build: {
					outDir: options.outDir,
					target: "esnext",
					lib: {
						entry: {
							[ENTRY_NAME]: options.entry ?? VIRTUAL_ENTRY_ID,
							[APP_ENTRY_NAME]: options.app,
						},
						fileName: (_format, name) => (name === ENTRY_NAME ? output.entryFile : output.appFile),
						cssFileName: output.cssFile.replace(/\.css$/, ""),
						formats: ["es"],
					},
					copyPublicDir: false,
					cssCodeSplit: false,
					emptyOutDir: true,
					rolldownOptions: {
						output: {
							chunkFileNames: output.chunkFileNames,
							assetFileNames: (assetInfo: AssetInfo) => {
								const name = assetInfo.names?.[0] ?? assetInfo.name ?? "";
								return name.endsWith(".css") ? output.cssFile : output.assetFileNames;
							},
						},
					},
				},
			} satisfies UserConfig;
		},
		resolveId(id) {
			if (id === VIRTUAL_MODULE_ID) return RESOLVED_VIRTUAL_MODULE_ID;
			if (id === VIRTUAL_ENTRY_ID) return RESOLVED_VIRTUAL_ENTRY_ID;
			if (id === DEV_ENTRY_ID || id === DEV_ENTRY_WIDGET_ID) return RESOLVED_VIRTUAL_ENTRY_ID;
			return null;
		},
		load(id) {
			if (id === RESOLVED_VIRTUAL_MODULE_ID) return virtualModuleSource(options, output, command);
			if (id === RESOLVED_VIRTUAL_ENTRY_ID) return virtualEntrySource();
			return null;
		},
		generateBundle(_rollupOptions, bundle) {
			let appModule: string | undefined;
			let entryModule: { code: string } | undefined;

			for (const item of Object.values(bundle)) {
				if (item.type !== "chunk") continue;
				if (item.name === APP_ENTRY_NAME) appModule = item.fileName;
				if (item.fileName === output.entryFile) entryModule = item;
			}

			if (!appModule) this.error("Could not find the anywidget bundle app chunk.");
			if (!entryModule) this.error("Could not find the anywidget bundle entry module.");
			if (!entryModule.code.includes(APP_MODULE_PLACEHOLDER)) {
				this.error("The anywidget bundle entry module does not import virtual:anywidget-bundle.");
			}

			entryModule.code = entryModule.code.split(APP_MODULE_PLACEHOLDER).join(appModule);
		},
	};
}

function outputOptions(
	options: AnyWidgetBundlePluginOptions,
): Required<NonNullable<AnyWidgetBundlePluginOptions["output"]>> {
	const output = options.output ?? {};
	const moduleDir = trimSlashes(output.moduleDir ?? "chunks");
	return {
		entryFile: output.entryFile ?? "widget.js",
		cssFile: output.cssFile ?? "widget.css",
		moduleDir,
		appFile: output.appFile ?? `${moduleDir}/widget-app.js`,
		chunkFileNames: output.chunkFileNames ?? `${moduleDir}/[name]-[hash].js`,
		assetFileNames: output.assetFileNames ?? "assets/[name]-[hash][extname]",
	};
}

function virtualModuleSource(
	options: AnyWidgetBundlePluginOptions,
	output: Required<NonNullable<AnyWidgetBundlePluginOptions["output"]>>,
	command: "build" | "serve",
): string {
	if (command === "serve") {
		return `
			import app from ${JSON.stringify(rootImport(options.app))};
			export function loadApp() {
				return Promise.resolve(app);
			}
		`;
	}
	return `
		import { loadAnyWidgetBundleApp } from ${JSON.stringify(runtimeImport())};
		const appModule = ${JSON.stringify(APP_MODULE_PLACEHOLDER)};
		export function loadApp(model, signal) {
			return loadAnyWidgetBundleApp(model, appModule, signal, { moduleDir: ${JSON.stringify(output.moduleDir)} });
		}
	`;
}

function virtualEntrySource(): string {
	return `
		import { loadApp } from "virtual:anywidget-bundle";
		export default {
			async initialize(props) {
				const signal = props.signal ?? new AbortController().signal;
				if (signal.aborted) return;
				const app = await loadApp(props.model, signal);
				if (!signal.aborted) await app.initialize?.({ ...props, signal });
			},
			async render(props) {
				const signal = props.signal ?? new AbortController().signal;
				if (signal.aborted) return;
				const app = await loadApp(props.model, signal);
				if (!signal.aborted) await app.render({ ...props, signal });
			}
		};
	`;
}

function rootImport(id: string): string {
	const normalized = normalizePath(id);
	if (normalized.startsWith("/") || normalized.startsWith("@fs/") || normalized.includes(":")) return normalized;
	return `/${normalized}`;
}

function runtimeImport(): string {
	const path = normalizePath(decodeURIComponent(new URL("./runtime.ts", import.meta.url).pathname));
	return `/@fs${path}`;
}

function trimSlashes(value: string): string {
	return value.replace(/^\/+|\/+$/g, "");
}
