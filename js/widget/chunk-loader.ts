import type { InitializeProps, RenderProps } from "@anywidget/types";
import type { WidgetAnyModel, WidgetModel } from "./types";

const RESPONSE_TRAIT = "_esm_chunk_response";
const REQUEST_TRAIT = "_esm_chunk_request";
const IMPORT_DECLARATION_PATTERN = /(\bimport(?!\s*\()[^'";]*?)(["'])(\.{1,2}\/[^"']+\.js)\2/g;
const EXPORT_FROM_PATTERN = /(\bexport\b[^'";]*?\bfrom\s*)(["'])(\.{1,2}\/[^"']+\.js)\2/g;
const DYNAMIC_IMPORT_PATTERN = /\bimport\s*\(\s*(["'])(\.{1,2}\/[^"']+\.js)\1\s*\)/g;
const CHUNK_TIMEOUT_MS = 30_000;
const LOADER_REGISTRY = "__pyobservablejsChunkLoaders";

type ChunkResponse = {
	seq?: unknown;
	path?: unknown;
	source?: unknown;
	error?: unknown;
};

type LoaderState = {
	id: string;
	nextSeq: number;
	modules: Map<string, Promise<unknown>>;
	requestQueue: Promise<void>;
	urls: Map<string, Promise<string>>;
};

type ChunkLoaderOptions = {
	createModuleUrl?: (source: string, path: string) => string;
	importModule?: (url: string) => Promise<unknown>;
	timeoutMs?: number;
};

export type WidgetApp = {
	initialize?: (props: InitializeProps<WidgetModel> & { signal?: AbortSignal }) => void;
	render: (props: RenderProps<WidgetModel> & { signal?: AbortSignal }) => void;
};

const loaderStates = new WeakMap<WidgetAnyModel, LoaderState>();

export async function loadWidgetApp(
	model: WidgetAnyModel,
	path: string,
	signal: AbortSignal,
	options: ChunkLoaderOptions = {},
): Promise<WidgetApp> {
	const state = loaderState(model);
	registerDynamicLoader(model, state, signal, options);
	const module = await importChunkModule(model, state, path, signal, options);
	const app = moduleValue(module);
	if (!isWidgetApp(app)) throw new Error("Widget app chunk does not export a render function");
	return app;
}

async function ensureModuleUrl(
	model: WidgetAnyModel,
	state: LoaderState,
	path: string,
	signal: AbortSignal,
	options: ChunkLoaderOptions,
): Promise<string> {
	const existing = state.urls.get(path);
	if (existing) return existing;
	const nextUrl = createModuleUrl(model, state, path, signal, options);
	state.urls.set(path, nextUrl);
	return nextUrl;
}

async function importChunkModule(
	model: WidgetAnyModel,
	state: LoaderState,
	path: string,
	signal: AbortSignal,
	options: ChunkLoaderOptions,
): Promise<unknown> {
	const existing = state.modules.get(path);
	if (existing) return existing;
	const nextModule = ensureModuleUrl(model, state, path, signal, options).then((url) =>
		(options.importModule ?? importModule)(url),
	);
	state.modules.set(path, nextModule);
	return nextModule;
}

async function createModuleUrl(
	model: WidgetAnyModel,
	state: LoaderState,
	path: string,
	signal: AbortSignal,
	options: ChunkLoaderOptions,
): Promise<string> {
	const source = await requestChunkSource(model, state, path, signal, options.timeoutMs ?? CHUNK_TIMEOUT_MS);
	const dependencyUrls = new Map(
		await Promise.all(
			Array.from(staticImportSpecifiers(source), async (specifier) => {
				const dependencyPath = resolveRelativePath(path, specifier);
				const url = await ensureModuleUrl(model, state, dependencyPath, signal, options);
				return [dependencyPath, url] as const;
			}),
		),
	);
	const rewritten = rewriteStaticImports(source, path, dependencyUrls).replace(
		DYNAMIC_IMPORT_PATTERN,
		(_match, _quote: string, specifier: string) => {
			return dynamicImportExpression(state.id, resolveRelativePath(path, specifier));
		},
	);
	return (options.createModuleUrl ?? createBlobModuleUrl)(rewritten, path);
}

async function requestChunkSource(
	model: WidgetAnyModel,
	state: LoaderState,
	path: string,
	signal: AbortSignal,
	timeoutMs: number,
): Promise<string> {
	const previous = state.requestQueue;
	let releaseQueue: () => void = () => {};
	state.requestQueue = new Promise((resolve) => {
		releaseQueue = resolve;
	});
	await previous;
	try {
		return await requestChunkSourceNow(model, state, path, signal, timeoutMs);
	} finally {
		releaseQueue();
	}
}

async function requestChunkSourceNow(
	model: WidgetAnyModel,
	state: LoaderState,
	path: string,
	signal: AbortSignal,
	timeoutMs: number,
): Promise<string> {
	if (signal.aborted) throw new DOMException("Chunk request aborted", "AbortError");
	const seq = state.nextSeq++;
	return new Promise((resolve, reject) => {
		let timeout: ReturnType<typeof window.setTimeout> | undefined;
		const cleanup = () => {
			model.off?.(`change:${RESPONSE_TRAIT}`, onResponse);
			signal.removeEventListener("abort", onAbort);
			if (timeout !== undefined) window.clearTimeout(timeout);
		};
		const finish = (callback: () => void) => {
			cleanup();
			callback();
		};
		const onAbort = () => {
			finish(() => reject(new DOMException("Chunk request aborted", "AbortError")));
		};
		const onResponse = () => {
			const response = model.get(RESPONSE_TRAIT) as ChunkResponse | undefined;
			if (!response || response.seq !== seq) return;
			finish(() => {
				if (response.error !== undefined) {
					reject(new Error(String(response.error)));
				} else if (response.path !== path) {
					reject(new Error(`Chunk response path mismatch: ${String(response.path)}`));
				} else if (typeof response.source !== "string") {
					reject(new Error("Chunk response did not include source text"));
				} else {
					resolve(response.source);
				}
			});
		};
		model.on?.(`change:${RESPONSE_TRAIT}`, onResponse);
		signal.addEventListener("abort", onAbort, { once: true });
		timeout = window.setTimeout(() => {
			finish(() => reject(new Error(`Timed out loading widget chunk ${path}`)));
		}, timeoutMs);
		model.set(REQUEST_TRAIT, { seq, path });
		model.save_changes?.();
		onResponse();
	});
}

function loaderState(model: WidgetAnyModel): LoaderState {
	const existing = loaderStates.get(model);
	if (existing) return existing;
	const state = {
		id: Math.random().toString(36).slice(2),
		nextSeq: 1,
		modules: new Map<string, Promise<unknown>>(),
		requestQueue: Promise.resolve(),
		urls: new Map<string, Promise<string>>(),
	};
	loaderStates.set(model, state);
	return state;
}

function staticImportSpecifiers(source: string): Set<string> {
	const specifiers = new Set<string>();
	for (const pattern of [IMPORT_DECLARATION_PATTERN, EXPORT_FROM_PATTERN]) {
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
	return source.replace(IMPORT_DECLARATION_PATTERN, rewrite).replace(EXPORT_FROM_PATTERN, rewrite);
}

function registerDynamicLoader(
	model: WidgetAnyModel,
	state: LoaderState,
	signal: AbortSignal,
	options: ChunkLoaderOptions,
): void {
	const registry = chunkLoaderRegistry();
	const load = (path: string) => importChunkModule(model, state, path, signal, options);
	registry[state.id] = load;
	signal.addEventListener(
		"abort",
		() => {
			if (registry[state.id] === load) delete registry[state.id];
		},
		{ once: true },
	);
}

function chunkLoaderRegistry(): Record<string, (path: string) => Promise<unknown>> {
	const global = globalThis as typeof globalThis & {
		__pyobservablejsChunkLoaders?: Record<string, (path: string) => Promise<unknown>>;
	};
	return (global.__pyobservablejsChunkLoaders ??= {});
}

function dynamicImportExpression(loaderId: string, path: string): string {
	return `globalThis[${JSON.stringify(LOADER_REGISTRY)}][${JSON.stringify(loaderId)}](${JSON.stringify(path)})`;
}

function resolveRelativePath(path: string, specifier: string): string {
	const parts: string[] = [];
	for (const part of [...path.split("/").slice(0, -1), ...specifier.split("/")]) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (parts.length === 0) throw new Error(`Chunk import escapes root: ${specifier}`);
			parts.pop();
		} else {
			parts.push(part);
		}
	}
	return parts.join("/");
}

function createBlobModuleUrl(source: string): string {
	return URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
}

async function importModule(url: string): Promise<unknown> {
	return await import(url);
}

function moduleValue(module: unknown): unknown {
	if (module && typeof module === "object" && "default" in module) {
		return (module as { default: unknown }).default;
	}
	return module;
}

function isWidgetApp(value: unknown): value is WidgetApp {
	return value !== null && typeof value === "object" && typeof (value as { render?: unknown }).render === "function";
}
