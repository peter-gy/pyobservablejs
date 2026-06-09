import type { InitializeProps, RenderProps } from "@anywidget/types";

export type AnyWidgetState = Record<string, unknown>;

export type AnyWidgetApp<ModelState extends AnyWidgetState> = {
	initialize?: (props: InitializeProps<ModelState> & { signal?: AbortSignal }) => void | Promise<void>;
	render: (props: RenderProps<ModelState> & { signal?: AbortSignal }) => void | Promise<void>;
};

export type ChunkedAnyWidgetModel = {
	get(name: string): unknown;
	set(name: string, value: unknown): void;
	save_changes?(): void;
	on?(name: string, callback: () => void): void;
	off?(name: string, callback: () => void): void;
};

const MODULE_RESPONSE_TRAIT = "_esm_module_response";
const MODULE_REQUEST_TRAIT = "_esm_module_request";
const STATIC_IMPORT_PATTERN = /(\bimport(?!\s*\()[^'";]*?)(["'])(\.{1,2}\/[^"']+\.js)\2/g;
const EXPORT_FROM_PATTERN = /(\bexport\b[^'";]*?\bfrom\s*)(["'])(\.{1,2}\/[^"']+\.js)\2/g;
const DYNAMIC_IMPORT_PATTERN = /\bimport\s*\(\s*(["'])(\.{1,2}\/[^"']+\.js)\1\s*\)/g;
const LOADER_REGISTRY = "__chunkedAnyWidgetModuleLoaders";
const MODULE_TIMEOUT_MS = 30_000;

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
	urls: Map<string, Promise<string>>;
};

export type ChunkedModuleLoaderOptions = {
	createModuleUrl?: (source: string, path: string) => string;
	importModule?: (url: string) => Promise<unknown>;
};

const states = new WeakMap<ChunkedAnyWidgetModel, ModuleState>();

export async function loadChunkedAnyWidgetApp<ModelState extends AnyWidgetState>(
	model: ChunkedAnyWidgetModel,
	path: string,
	signal: AbortSignal,
	options: ChunkedModuleLoaderOptions = {},
): Promise<AnyWidgetApp<ModelState>> {
	const state = stateFor(model);
	registerDynamicLoader(model, state, signal, options);
	const module = await importModule(model, state, path, signal, options);
	const app = moduleValue(module);
	if (!isAnyWidgetApp<ModelState>(app)) throw new Error("Widget app module does not export a render function");
	return app;
}

async function importModule(
	model: ChunkedAnyWidgetModel,
	state: ModuleState,
	path: string,
	signal: AbortSignal,
	options: ChunkedModuleLoaderOptions,
): Promise<unknown> {
	const existing = state.modules.get(path);
	if (existing) return existing;
	const nextModule = moduleUrl(model, state, path, signal, options).then((url) =>
		(options.importModule ?? importModuleUrl)(url),
	);
	state.modules.set(path, nextModule);
	return nextModule;
}

async function moduleUrl(
	model: ChunkedAnyWidgetModel,
	state: ModuleState,
	path: string,
	signal: AbortSignal,
	options: ChunkedModuleLoaderOptions,
): Promise<string> {
	const existing = state.urls.get(path);
	if (existing) return existing;
	const nextUrl = createModuleUrl(model, state, path, signal, options);
	state.urls.set(path, nextUrl);
	return nextUrl;
}

async function createModuleUrl(
	model: ChunkedAnyWidgetModel,
	state: ModuleState,
	path: string,
	signal: AbortSignal,
	options: ChunkedModuleLoaderOptions,
): Promise<string> {
	const source = await readModuleSource(model, state, path, signal);
	const imports = new Map(
		await Promise.all(
			Array.from(staticImportSpecifiers(source), async (specifier) => {
				const dependencyPath = resolveRelativePath(path, specifier);
				const url = await moduleUrl(model, state, dependencyPath, signal, options);
				return [dependencyPath, url] as const;
			}),
		),
	);
	const rewritten = rewriteStaticImports(source, path, imports).replace(
		DYNAMIC_IMPORT_PATTERN,
		(_match, _quote: string, specifier: string) => {
			const dependencyPath = resolveRelativePath(path, specifier);
			return dynamicImportExpression(state.id, dependencyPath);
		},
	);
	return (options.createModuleUrl ?? createBlobModuleUrl)(rewritten, path);
}

async function readModuleSource(
	model: ChunkedAnyWidgetModel,
	state: ModuleState,
	path: string,
	signal: AbortSignal,
): Promise<string> {
	const previous = state.requestQueue;
	let releaseQueue: () => void = () => {};
	state.requestQueue = new Promise((resolve) => {
		releaseQueue = resolve;
	});
	await previous;
	try {
		return await readModuleSourceNow(model, state, path, signal);
	} finally {
		releaseQueue();
	}
}

async function readModuleSourceNow(
	model: ChunkedAnyWidgetModel,
	state: ModuleState,
	path: string,
	signal: AbortSignal,
): Promise<string> {
	if (signal.aborted) throw new DOMException("Widget module request aborted", "AbortError");
	return await readModuleSourceViaTraitlet(model, state, path, signal);
}

function readModuleSourceViaTraitlet(
	model: ChunkedAnyWidgetModel,
	state: ModuleState,
	path: string,
	signal: AbortSignal,
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
			finish(() => reject(new DOMException("Widget module request aborted", "AbortError")));
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
			finish(() => reject(new Error(`Timed out loading widget module ${path}`)));
		}, MODULE_TIMEOUT_MS);
		model.set(MODULE_REQUEST_TRAIT, { seq, path });
		model.save_changes?.();
		onResponse();
	});
}

function moduleSourceFromResponse(response: ModuleResponse, path: string): string {
	if (response.error !== undefined) throw new Error(String(response.error));
	if (response.path !== path) throw new Error(`Widget module response path mismatch: ${String(response.path)}`);
	if (typeof response.source !== "string") throw new Error(`Widget module ${path} did not return source text`);
	return response.source;
}

function stateFor(model: ChunkedAnyWidgetModel): ModuleState {
	const existing = states.get(model);
	if (existing) return existing;
	const state = {
		id: Math.random().toString(36).slice(2),
		nextSeq: 1,
		modules: new Map<string, Promise<unknown>>(),
		requestQueue: Promise.resolve(),
		urls: new Map<string, Promise<string>>(),
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

function rewriteStaticImports(source: string, path: string, dependencyUrls: Map<string, string>): string {
	const rewrite = (match: string, prefix: string, quote: string, specifier: string) => {
		const dependencyPath = resolveRelativePath(path, specifier);
		const url = dependencyUrls.get(dependencyPath);
		return url === undefined ? match : `${prefix}${quote}${url}${quote}`;
	};
	return source.replace(STATIC_IMPORT_PATTERN, rewrite).replace(EXPORT_FROM_PATTERN, rewrite);
}

function resolveRelativePath(path: string, specifier: string): string {
	const parts: string[] = [];
	for (const part of [...path.split("/").slice(0, -1), ...specifier.split("/")]) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (parts.length === 0) throw new Error(`Widget module import escapes static root: ${specifier}`);
			parts.pop();
		} else {
			parts.push(part);
		}
	}
	return parts.join("/");
}

function registerDynamicLoader(
	model: ChunkedAnyWidgetModel,
	state: ModuleState,
	signal: AbortSignal,
	options: ChunkedModuleLoaderOptions,
): void {
	const registry = moduleLoaderRegistry();
	const load = (path: string) => importModule(model, state, path, signal, options);
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
		__chunkedAnyWidgetModuleLoaders?: Record<string, (path: string) => Promise<unknown>>;
	};
	return (global.__chunkedAnyWidgetModuleLoaders ??= {});
}

function dynamicImportExpression(loaderId: string, path: string): string {
	return `globalThis[${JSON.stringify(LOADER_REGISTRY)}][${JSON.stringify(loaderId)}](${JSON.stringify(path)})`;
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
