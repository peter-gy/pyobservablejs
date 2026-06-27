import type { InitializeProps, RenderProps } from "@anywidget/types";

export type AnyWidgetState = Record<string, unknown>;

export type AnyWidgetApp<ModelState extends AnyWidgetState> = {
	initialize?: (props: InitializeProps<ModelState> & { signal?: AbortSignal }) => void | Promise<void>;
	render: (props: RenderProps<ModelState> & { signal?: AbortSignal }) => void | Promise<void>;
};

export type AnyWidgetBundleModel = {
	get(name: string): unknown;
	set(name: string, value: unknown): void;
	save_changes?(): void;
	on?(name: string, callback: () => void): void;
	off?(name: string, callback: () => void): void;
};

const MODULE_RESPONSE_TRAIT = "_anywidget_bundle_module_response";
const MODULE_REQUEST_TRAIT = "_anywidget_bundle_module_request";
const STATIC_IMPORT_PATTERN = /(\bimport(?!\s*\()[^'";]*?)(["'])(\.{1,2}\/[^"']+\.js)\2/g;
const EXPORT_FROM_PATTERN = /(\bexport\b[^'";]*?\bfrom\s*)(["'])(\.{1,2}\/[^"']+\.js)\2/g;
const DYNAMIC_IMPORT_PATTERN = /\bimport\s*\(\s*(["'])(\.{1,2}\/[^"']+\.js)\1\s*\)/g;
const LOADER_REGISTRY = "__anyWidgetBundleModuleLoaders";
const DEFAULT_MODULE_DIR = "chunks";
const DEFAULT_MODULE_TIMEOUT_MS = 30_000;

type ModuleResponse = {
	seq?: unknown;
	path?: unknown;
	source?: unknown;
	error?: unknown;
};

type ModuleState = {
	id: string;
	nextSeq: number;
	modules: Map<string, Promise<unknown>>;
	requestQueue: Promise<void>;
};

type ModuleLoadSession = {
	urls: Map<string, Promise<string>>;
	objectUrls: Set<string>;
	disposed: boolean;
	dispose(): void;
};

export type AnyWidgetBundleLoaderOptions = {
	moduleDir?: string;
	timeoutMs?: number;
	createModuleUrl?: (source: string, path: string) => string;
	importModule?: (url: string) => Promise<unknown>;
};

const states = new WeakMap<AnyWidgetBundleModel, ModuleState>();

export async function loadAnyWidgetBundleApp<ModelState extends AnyWidgetState>(
	model: AnyWidgetBundleModel,
	path: string,
	signal: AbortSignal,
	options: AnyWidgetBundleLoaderOptions = {},
): Promise<AnyWidgetApp<ModelState>> {
	const state = stateFor(model);
	registerDynamicLoader(model, state, signal, options);
	const module = await withModuleLoadSession(signal, (session) =>
		importModule(model, state, path, signal, options, session),
	);
	const app = moduleValue(module);
	if (!isAnyWidgetApp<ModelState>(app)) throw new Error("Anywidget bundle module does not export a render function");
	return app;
}

async function importModule(
	model: AnyWidgetBundleModel,
	state: ModuleState,
	path: string,
	signal: AbortSignal,
	options: AnyWidgetBundleLoaderOptions,
	session: ModuleLoadSession,
): Promise<unknown> {
	const modulePath = normalizeModulePath(path, moduleDir(options));
	const existing = state.modules.get(modulePath);
	if (existing) return existing;
	const nextModule = moduleUrl(model, state, modulePath, signal, options, session).then((url) => {
		if (signal.aborted || session.disposed)
			throw new DOMException("Anywidget bundle module request aborted", "AbortError");
		return (options.importModule ?? importModuleUrl)(url);
	});
	state.modules.set(modulePath, nextModule);
	try {
		return await nextModule;
	} catch (error) {
		if (state.modules.get(modulePath) === nextModule) state.modules.delete(modulePath);
		throw error;
	}
}

async function moduleUrl(
	model: AnyWidgetBundleModel,
	state: ModuleState,
	path: string,
	signal: AbortSignal,
	options: AnyWidgetBundleLoaderOptions,
	session: ModuleLoadSession,
): Promise<string> {
	const existing = session.urls.get(path);
	if (existing) return existing;
	const nextUrl = createModuleUrl(model, state, path, signal, options, session);
	session.urls.set(path, nextUrl);
	try {
		return await nextUrl;
	} catch (error) {
		if (session.urls.get(path) === nextUrl) session.urls.delete(path);
		throw error;
	}
}

async function createModuleUrl(
	model: AnyWidgetBundleModel,
	state: ModuleState,
	path: string,
	signal: AbortSignal,
	options: AnyWidgetBundleLoaderOptions,
	session: ModuleLoadSession,
): Promise<string> {
	const source = await readModuleSource(model, state, path, signal, options);
	const imports = new Map(
		await Promise.all(
			Array.from(staticImportSpecifiers(source), async (specifier) => {
				const dependencyPath = resolveRelativePath(path, specifier, moduleDir(options));
				const url = await moduleUrl(model, state, dependencyPath, signal, options, session);
				return [dependencyPath, url] as const;
			}),
		),
	);
	const rewritten = rewriteStaticImports(source, path, imports, moduleDir(options)).replace(
		DYNAMIC_IMPORT_PATTERN,
		(_match, _quote: string, specifier: string) => {
			const dependencyPath = resolveRelativePath(path, specifier, moduleDir(options));
			return dynamicImportExpression(state.id, dependencyPath);
		},
	);
	return createSessionModuleUrl(session, rewritten, path, options);
}

async function readModuleSource(
	model: AnyWidgetBundleModel,
	state: ModuleState,
	path: string,
	signal: AbortSignal,
	options: AnyWidgetBundleLoaderOptions,
): Promise<string> {
	const previous = state.requestQueue;
	let releaseQueue: () => void = () => {};
	state.requestQueue = new Promise((resolve) => {
		releaseQueue = resolve;
	});
	await previous;
	try {
		return await readModuleSourceNow(model, state, path, signal, options);
	} finally {
		releaseQueue();
	}
}

async function readModuleSourceNow(
	model: AnyWidgetBundleModel,
	state: ModuleState,
	path: string,
	signal: AbortSignal,
	options: AnyWidgetBundleLoaderOptions,
): Promise<string> {
	if (signal.aborted) throw new DOMException("Anywidget bundle module request aborted", "AbortError");
	return await readModuleSourceViaTraitlet(model, state, path, signal, options);
}

function readModuleSourceViaTraitlet(
	model: AnyWidgetBundleModel,
	state: ModuleState,
	path: string,
	signal: AbortSignal,
	options: AnyWidgetBundleLoaderOptions,
): Promise<string> {
	const seq = state.nextSeq++;
	return new Promise((resolve, reject) => {
		let timeout: ReturnType<typeof window.setTimeout> | undefined;
		const cleanup = () => {
			model.off?.(`change:${MODULE_RESPONSE_TRAIT}`, onResponse);
			signal.removeEventListener("abort", onAbort);
			if (timeout !== undefined) window.clearTimeout(timeout);
		};
		const finish = (callback: () => void) => {
			cleanup();
			callback();
		};
		const onAbort = () => {
			finish(() => reject(new DOMException("Anywidget bundle module request aborted", "AbortError")));
		};
		const onResponse = () => {
			const response = model.get(MODULE_RESPONSE_TRAIT) as ModuleResponse | undefined;
			if (!response || response.seq !== seq) return;
			finish(() => {
				try {
					resolve(moduleSourceFromResponse(response, path));
				} catch (error) {
					reject(error);
				}
			});
		};
		model.on?.(`change:${MODULE_RESPONSE_TRAIT}`, onResponse);
		signal.addEventListener("abort", onAbort, { once: true });
		timeout = window.setTimeout(() => {
			finish(() => reject(new Error(`Timed out loading anywidget bundle module ${path}`)));
		}, options.timeoutMs ?? DEFAULT_MODULE_TIMEOUT_MS);
		model.set(MODULE_REQUEST_TRAIT, { seq, path });
		model.save_changes?.();
		onResponse();
	});
}

function moduleSourceFromResponse(response: ModuleResponse, path: string): string {
	if (response.error !== undefined) throw new Error(String(response.error));
	if (response.path !== path)
		throw new Error(`Anywidget bundle module response path mismatch: ${String(response.path)}`);
	if (typeof response.source !== "string")
		throw new Error(`Anywidget bundle module ${path} did not return source text`);
	return response.source;
}

function stateFor(model: AnyWidgetBundleModel): ModuleState {
	const existing = states.get(model);
	if (existing) return existing;
	const state = {
		id: Math.random().toString(36).slice(2),
		nextSeq: 1,
		modules: new Map<string, Promise<unknown>>(),
		requestQueue: Promise.resolve(),
	};
	states.set(model, state);
	return state;
}

function staticImportSpecifiers(source: string): Set<string> {
	const specifiers = new Set<string>();
	for (const pattern of [STATIC_IMPORT_PATTERN, EXPORT_FROM_PATTERN]) {
		source.replace(pattern, (_match, _prefix: string, _quote: string, specifier: string) => {
			specifiers.add(specifier);
			return "";
		});
	}
	return specifiers;
}

function rewriteStaticImports(
	source: string,
	path: string,
	dependencyUrls: Map<string, string>,
	moduleDirName: string,
): string {
	const rewrite = (match: string, prefix: string, quote: string, specifier: string) => {
		const dependencyPath = resolveRelativePath(path, specifier, moduleDirName);
		const url = dependencyUrls.get(dependencyPath);
		return url === undefined ? match : `${prefix}${quote}${url}${quote}`;
	};
	return source.replace(STATIC_IMPORT_PATTERN, rewrite).replace(EXPORT_FROM_PATTERN, rewrite);
}

function resolveRelativePath(path: string, specifier: string, moduleDirName: string): string {
	const parts: string[] = [];
	for (const part of [...path.split("/").slice(0, -1), ...specifier.split("/")]) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (parts.length === 0) throw new Error(`Anywidget bundle import escapes module directory: ${specifier}`);
			parts.pop();
		} else {
			parts.push(part);
		}
	}
	return normalizeModulePath(parts.join("/"), moduleDirName);
}

function normalizeModulePath(path: string, moduleDirName: string): string {
	const parts = path.split("/");
	const moduleParts = moduleDirName.split("/");
	if (
		path.startsWith("/") ||
		parts.some((part) => !part || part === "." || part === "..") ||
		parts.length <= moduleParts.length ||
		parts.slice(0, moduleParts.length).join("/") !== moduleDirName ||
		!path.endsWith(".js")
	) {
		throw new Error(`Unsupported anywidget bundle module path: ${path}`);
	}
	return path;
}

function moduleDir(options: AnyWidgetBundleLoaderOptions): string {
	return (options.moduleDir ?? DEFAULT_MODULE_DIR).replace(/^\/+|\/+$/g, "");
}

function registerDynamicLoader(
	model: AnyWidgetBundleModel,
	state: ModuleState,
	signal: AbortSignal,
	options: AnyWidgetBundleLoaderOptions,
): void {
	const registry = moduleLoaderRegistry();
	const load = (path: string) =>
		withModuleLoadSession(signal, (session) => importModule(model, state, path, signal, options, session));
	registry[state.id] = load;
	signal.addEventListener(
		"abort",
		() => {
			if (registry[state.id] === load) delete registry[state.id];
		},
		{ once: true },
	);
}

function moduleLoaderRegistry(): Record<string, (path: string) => Promise<unknown>> {
	const global = globalThis as typeof globalThis & {
		__anyWidgetBundleModuleLoaders?: Record<string, (path: string) => Promise<unknown>>;
	};
	return (global.__anyWidgetBundleModuleLoaders ??= {});
}

function dynamicImportExpression(loaderId: string, path: string): string {
	return `globalThis[${JSON.stringify(LOADER_REGISTRY)}][${JSON.stringify(loaderId)}](${JSON.stringify(path)})`;
}

async function withModuleLoadSession<T>(
	signal: AbortSignal,
	load: (session: ModuleLoadSession) => Promise<T>,
): Promise<T> {
	const session = createModuleLoadSession(signal);
	try {
		return await load(session);
	} finally {
		session.dispose();
	}
}

function createModuleLoadSession(signal: AbortSignal): ModuleLoadSession {
	const objectUrls = new Set<string>();
	const session: ModuleLoadSession = {
		urls: new Map(),
		objectUrls,
		disposed: false,
		dispose() {
			if (session.disposed) return;
			session.disposed = true;
			signal.removeEventListener("abort", onAbort);
			for (const url of objectUrls) URL.revokeObjectURL(url);
			objectUrls.clear();
		},
	};
	const onAbort = () => session.dispose();
	signal.addEventListener("abort", onAbort, { once: true });
	if (signal.aborted) session.dispose();
	return session;
}

function createSessionModuleUrl(
	session: ModuleLoadSession,
	source: string,
	path: string,
	options: AnyWidgetBundleLoaderOptions,
): string {
	if (session.disposed) throw new DOMException("Anywidget bundle module request aborted", "AbortError");
	if (options.createModuleUrl) {
		const url = options.createModuleUrl(source, path);
		if (session.disposed) throw new DOMException("Anywidget bundle module request aborted", "AbortError");
		return url;
	}
	const url = createBlobModuleUrl(source);
	if (session.disposed) {
		URL.revokeObjectURL(url);
		throw new DOMException("Anywidget bundle module request aborted", "AbortError");
	}
	session.objectUrls.add(url);
	return url;
}

function createBlobModuleUrl(source: string): string {
	return URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
}

async function importModuleUrl(url: string): Promise<unknown> {
	return await import(/* @vite-ignore */ url);
}

function moduleValue(module: unknown): unknown {
	if (module && typeof module === "object" && "default" in module) {
		return (module as { default: unknown }).default;
	}
	return module;
}

function isAnyWidgetApp<ModelState extends AnyWidgetState>(value: unknown): value is AnyWidgetApp<ModelState> {
	return value !== null && typeof value === "object" && typeof (value as { render?: unknown }).render === "function";
}
