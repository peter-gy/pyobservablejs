import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";
import { normalizePath, type Plugin, type UserConfig } from "vite";
import {
	artifactPathsConflict,
	isJavaScriptArtifactPath,
	isSafeArtifactPath,
	javascriptExtension,
} from "./artifact-path";

export type AnyWidgetBundleOutputOptions = {
	entry?: string;
	app?: string;
	style?: string;
};

export type AnyWidgetBundleOptions = {
	app: string;
	outDir: string;
	devEntry?: string;
	output?: AnyWidgetBundleOutputOptions;
};

type BundleManifest = {
	version: 1;
	entry: string;
	style: string | null;
	app: string;
	modules: string[];
};

type BundleOptions = {
	app: string;
	outDir: string;
	devEntry: string;
	output: Required<AnyWidgetBundleOutputOptions>;
	chunkFileNames: string;
};

type ChunkInfo = {
	type: "chunk";
	fileName: string;
	code: string;
	imports: string[];
	dynamicImports: string[];
};

type AssetInfo = {
	type: "asset";
	fileName: string;
};

const DEV_RUNTIME_ID = "virtual:anywidget-bundle/dev-runtime";
const ENTRY_NAME = "index";
const APP_ENTRY_NAME = "app";
const MANIFEST_FILE = "anywidget.json";
const DEFAULT_DEV_ENTRY = "/@anywidget-bundle/entry";
const VITE_ID_PREFIX = "/@id/";
const VITE_NULL_BYTE = "__x00__";
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:\//;
const DEFAULT_OUTPUT = {
	entry: "index.js",
	app: "chunks/app.js",
	style: "widget.css",
} as const;

export default function anywidgetBundle(rawOptions: AnyWidgetBundleOptions): Plugin {
	const options = resolveOptions(rawOptions);
	return bundlePlugin(options);
}

function bundlePlugin(options: BundleOptions): Plugin {
	let command: "build" | "serve" = "build";
	let root = process.cwd();
	const resolvedDevEntryId = `\0virtual:anywidget-bundle/dev-entry:${options.devEntry}`;
	// Generated source imports a browser-form ID. Keep the resolver's original
	// ID so virtual and out-of-root apps re-enter Vite through the same module.
	const developmentAppIds = new Map<string, string>();
	return {
		name: "anywidget-bundle",
		config(_config, env) {
			command = env.command;
			return bundleConfig(options, env.command);
		},
		configResolved(config) {
			root = config.root;
		},
		async buildStart() {
			if (command === "build") validateResolvedAppImport(await resolveAppImport(this, options.app));
		},
		resolveId(id) {
			if (id === DEV_RUNTIME_ID) return runtimeSourcePath("dev");
			if (isDevelopmentEntryRequest(id, options.devEntry)) return resolvedDevEntryId;
			const appId = developmentAppIds.get(id);
			if (appId) return appId;
			return null;
		},
		async load(id) {
			if (id === resolvedDevEntryId) {
				const app = await resolveAppImport(this, options.app);
				validateResolvedAppImport(app);
				const browserApp = browserImport(app, root);
				developmentAppIds.clear();
				developmentAppIds.set(browserApp, app);
				return developmentEntrySource(browserApp);
			}
			return null;
		},
		// Run late so the manifest reflects the generated chunk graph. Python
		// treats its module list as the runtime read allowlist.
		generateBundle: {
			order: "post",
			handler(_output, bundle) {
				if (command !== "build") return;
				const fail = (message: string): never => this.error(message);
				const chunks = Object.values(bundle).filter((item): item is typeof item & ChunkInfo => item.type === "chunk");
				const entry = chunks.find((chunk) => chunk.fileName === options.output.entry);
				const app = chunks.find((chunk) => chunk.fileName === options.output.app);
				if (!entry) this.error(`Missing generated anywidget entry ${options.output.entry}.`);
				if (!app) this.error(`Missing generated anywidget app ${options.output.app}.`);
				// anywidget evaluates entry from _esm. App and other chunks are fetched
				// through Python, so entry must remain self-contained.
				if (entry.imports.length || entry.dynamicImports.length) {
					this.error("The generated anywidget entry must be self-contained.");
				}

				const modules = chunks
					.filter((chunk) => chunk.fileName !== options.output.entry)
					.map((chunk) => chunk.fileName)
					.sort((left, right) =>
						left === options.output.app ? -1 : right === options.output.app ? 1 : left.localeCompare(right),
					);
				validateModuleFiles(fail, modules, options.output.app);
				validateChunkReferences(fail, chunks, new Set(modules));
				validateStaticGraph(fail, chunks, new Set(modules));

				const assets = Object.values(bundle).filter((item): item is typeof item & AssetInfo => item.type === "asset");
				const style = validateAssets(fail, assets, options.output.style);
				const artifacts = [MANIFEST_FILE, options.output.entry, ...modules, ...(style ? [style] : [])];
				if (artifactPathsConflict(artifacts)) {
					this.error("Generated anywidget bundle artifact paths must not collide.");
				}
				const manifest: BundleManifest = {
					version: 1,
					entry: options.output.entry,
					style,
					app: options.output.app,
					modules,
				};
				this.emitFile({
					type: "asset",
					fileName: MANIFEST_FILE,
					source: `${JSON.stringify(manifest, null, 2)}\n`,
				});
			},
		},
	};
}

function bundleConfig(options: BundleOptions, command: "build" | "serve"): UserConfig {
	return {
		define: {
			"process.env.NODE_ENV": JSON.stringify(command === "serve" ? "development" : "production"),
			__ANYWIDGET_BUNDLE_APP_MODULE__: JSON.stringify(options.output.app),
		},
		build: {
			outDir: options.outDir,
			emptyOutDir: true,
			target: "esnext",
			lib: {
				// Build the bootstrap and app as separate roots. The bootstrap loads the
				// Python-served app graph through the module protocol.
				entry: {
					[ENTRY_NAME]: runtimeSourcePath("build"),
					[APP_ENTRY_NAME]: options.app,
				},
				cssFileName: "widget",
				formats: ["es"],
			},
			copyPublicDir: false,
			// The module protocol serves JavaScript. Inline other assets and collapse
			// CSS into the single stylesheet exposed through anywidget.
			cssCodeSplit: false,
			assetsInlineLimit: Number.MAX_SAFE_INTEGER,
			rollupOptions: {
				output: {
					entryFileNames: (chunk) => (chunk.name === ENTRY_NAME ? options.output.entry : options.output.app),
					chunkFileNames: options.chunkFileNames,
					assetFileNames: (asset) =>
						(asset.names?.[0] ?? asset.name ?? "").endsWith(".css")
							? options.output.style
							: "assets/[name]-[hash][extname]",
				},
			},
		},
	};
}

function developmentEntrySource(app: string): string {
	return `
		import { createAnyWidgetBundleDevelopmentEntry } from ${JSON.stringify(DEV_RUNTIME_ID)};
		import app from ${JSON.stringify(app)};
		const entry = createAnyWidgetBundleDevelopmentEntry(app);
		if (import.meta.hot) {
			const hot = import.meta.hot;
			const invalidate = (error) => {
				console.error("Anywidget bundle hot update failed.", error);
				hot.invalidate("Anywidget bundle hot update failed.");
			};
			import.meta.hot.accept(${JSON.stringify(app)}, (module) => {
				if (!module || !("default" in module)) {
					invalidate(new Error("Anywidget bundle app must have a default export."));
					return;
				}
				void entry.update(module.default).catch(invalidate);
			});
			import.meta.hot.dispose(() =>
				entry.dispose().catch((error) => {
					console.error("Anywidget bundle hot disposal failed.", error);
				}),
			);
		}
		export default entry.widget;
	`;
}

function validateModuleFiles(error: (message: string) => never, modules: readonly string[], app: string): void {
	if (!modules.includes(app)) error(`Bundle modules must include ${app}.`);
	for (const path of modules) {
		if (!isJavaScriptArtifactPath(path)) {
			error(`Unsupported anywidget bundle module path ${path}.`);
		}
	}
}

function validateChunkReferences(
	error: (message: string) => never,
	chunks: readonly ChunkInfo[],
	modules: ReadonlySet<string>,
): void {
	for (const chunk of chunks) {
		if (!modules.has(chunk.fileName)) continue;
		for (const dependency of [...chunk.imports, ...chunk.dynamicImports]) {
			if (!modules.has(dependency) && !isUrlImport(dependency)) {
				error(`Bundle module ${chunk.fileName} references unsupported module ${dependency}.`);
			}
		}
	}
}

function isUrlImport(specifier: string): boolean {
	return specifier.startsWith("https://") || specifier.startsWith("http://");
}

function validateStaticGraph(
	error: (message: string) => never,
	chunks: readonly ChunkInfo[],
	modules: ReadonlySet<string>,
): void {
	// The browser creates Blob URLs dependency-first. A static cycle has no first
	// URL that can be embedded, so reject it while Rollup exposes the graph.
	const graph = new Map(
		chunks
			.filter((chunk) => modules.has(chunk.fileName))
			.map((chunk) => [chunk.fileName, chunk.imports.filter((path) => modules.has(path))] as const),
	);
	const visited = new Set<string>();
	const active = new Set<string>();
	const visit = (path: string) => {
		if (active.has(path)) error(`Static anywidget bundle import cycle includes ${path}.`);
		if (visited.has(path)) return;
		active.add(path);
		for (const dependency of graph.get(path) ?? []) visit(dependency);
		active.delete(path);
		visited.add(path);
	};
	for (const path of graph.keys()) visit(path);
}

function validateAssets(
	error: (message: string) => never,
	assets: readonly AssetInfo[],
	styleFile: string,
): string | null {
	let style: string | null = null;
	for (const asset of assets) {
		if (asset.fileName !== styleFile) {
			error(`Unsupported emitted anywidget bundle asset ${asset.fileName}.`);
		}
		if (style) error(`The anywidget bundle emitted more than one ${styleFile}.`);
		style = styleFile;
	}
	return style;
}

function resolveOptions(options: AnyWidgetBundleOptions): BundleOptions {
	if (!isPlainObject(options)) throw new Error("anywidgetBundle options must be an object.");
	for (const key of Object.keys(options)) {
		if (key !== "app" && key !== "outDir" && key !== "devEntry" && key !== "output") {
			throw new Error(`anywidgetBundle ${key} is not supported.`);
		}
	}
	if (typeof options.app !== "string" || options.app.length === 0) {
		throw new Error("anywidgetBundle app must be a non-empty Vite module ID.");
	}
	if (typeof options.outDir !== "string" || options.outDir.length === 0) {
		throw new Error("anywidgetBundle outDir must be a non-empty directory path.");
	}
	const devEntry = options.devEntry === undefined ? DEFAULT_DEV_ENTRY : options.devEntry;
	validateDevEntry(devEntry);
	const outputOptions: unknown = options.output;
	if (outputOptions !== undefined && !isPlainObject(outputOptions)) {
		throw new Error("anywidgetBundle output must be an object.");
	}
	if (outputOptions) {
		for (const key of Object.keys(outputOptions)) {
			if (key !== "entry" && key !== "app" && key !== "style") {
				throw new Error(`anywidgetBundle output.${key} is not supported.`);
			}
		}
	}
	const output = {
		entry: validateOutputPath(
			"output.entry",
			outputOptions?.entry === undefined ? DEFAULT_OUTPUT.entry : outputOptions.entry,
			isJavaScriptArtifactPath,
		),
		app: validateOutputPath(
			"output.app",
			outputOptions?.app === undefined ? DEFAULT_OUTPUT.app : outputOptions.app,
			isJavaScriptArtifactPath,
		),
		style: validateOutputPath(
			"output.style",
			outputOptions?.style === undefined ? DEFAULT_OUTPUT.style : outputOptions.style,
			(value) => isSafeArtifactPath(value) && value.endsWith(".css"),
		),
	};
	if (artifactPathsConflict([MANIFEST_FILE, output.entry, output.app, output.style])) {
		throw new Error("anywidgetBundle output paths must not collide.");
	}
	// Keep split chunks beside the app entry and reuse its extension. The runtime
	// resolves Rollup's relative specifiers against these manifest paths.
	const slash = output.app.lastIndexOf("/");
	const directory = slash === -1 ? "" : output.app.slice(0, slash + 1);
	return {
		app: options.app,
		outDir: options.outDir,
		devEntry,
		output,
		chunkFileNames: `${directory}[name]-[hash]${javascriptExtension(output.app)}`,
	};
}

function validateDevEntry(value: string): void {
	if (typeof value !== "string") {
		throw new Error("anywidgetBundle devEntry must be an absolute Vite path without a query or fragment.");
	}
	if (
		!value.startsWith("/") ||
		value.startsWith("//") ||
		value.length === 1 ||
		value.includes("%") ||
		!isSafeArtifactPath(value.slice(1))
	) {
		throw new Error("anywidgetBundle devEntry must be an absolute Vite path without a query or fragment.");
	}
}

function validateOutputPath(label: string, value: unknown, accepts: (value: string) => boolean): string {
	if (typeof value !== "string" || !accepts(value)) {
		throw new Error(`anywidgetBundle ${label} must be a safe relative bundle path.`);
	}
	return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

async function resolveAppImport(context: { resolve: PluginContextResolve }, app: string): Promise<string> {
	const direct = await context.resolve(app, undefined, { skipSelf: true });
	if (direct) return direct.id;
	return app;
}

function validateResolvedAppImport(id: string): void {
	// Vite also uses query and fragment suffixes in resolved IDs. A successful
	// lookup means the delimiter belongs to the filename. The browser would parse
	// it as URL metadata.
	if (isAbsoluteFilePath(id) && (id.includes("?") || id.includes("#")) && existsSync(id)) {
		throw new Error("anywidgetBundle app filesystem paths must not contain ? or # filename characters.");
	}
}

type PluginContextResolve = (
	source: string,
	importer?: string,
	options?: { skipSelf?: boolean },
) => Promise<{ id: string } | null>;

function browserImport(id: string, root: string): string {
	// Resolved filesystem and virtual IDs must be rendered as Vite browser
	// request forms before they are embedded in the development entry.
	const normalized = normalizePath(id);
	if (normalized.startsWith("\0")) return `${VITE_ID_PREFIX}${normalized.replace("\0", VITE_NULL_BYTE)}`;
	if (normalized.startsWith("/@fs/") || normalized.startsWith(VITE_ID_PREFIX)) return normalized;
	if (isAbsoluteFilePath(normalized)) {
		const relativePath = relativeToRoot(normalizePath(root), normalized);
		if (relativePath !== undefined) return `/${relativePath}`;
		return `/@fs/${normalized.replace(/^\/+/, "")}`;
	}
	if (normalized.startsWith("/") || normalized.includes(":")) return normalized;
	return `/${normalized}`;
}

function isAbsoluteFilePath(path: string): boolean {
	return posix.isAbsolute(path) || win32.isAbsolute(path);
}

function relativeToRoot(root: string, id: string): string | undefined {
	const path = WINDOWS_DRIVE_PATH.test(root) || WINDOWS_DRIVE_PATH.test(id) ? win32 : posix;
	if (!path.isAbsolute(root) || !path.isAbsolute(id)) return undefined;
	const relativePath = normalizePath(path.relative(root, id));
	if (path.isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith("../")) return undefined;
	return relativePath;
}

function isDevelopmentEntryRequest(id: string, devEntry: string): boolean {
	return id === devEntry || id === `${devEntry}?anywidget`;
}

function runtimeSourcePath(module: "build" | "dev"): string {
	// Direct TypeScript execution and the published JavaScript plugin resolve
	// different sibling extensions.
	const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
	return normalizePath(decodeURIComponent(new URL(`${module}${extension}`, import.meta.url).pathname));
}
