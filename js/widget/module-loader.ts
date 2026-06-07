import type { Experimental, InitializeProps, RenderProps } from "@anywidget/types";
import type { WidgetAnyModel, WidgetModel } from "./types";

const RESPONSE_TRAIT = "_esm_module_response";
const REQUEST_TRAIT = "_esm_module_request";
const STATIC_IMPORT_PATTERN = /(\bimport(?!\s*\()[^'";]*?)(["'])(\.{1,2}\/[^"']+\.js)\2/g;
const EXPORT_FROM_PATTERN = /(\bexport\b[^'";]*?\bfrom\s*)(["'])(\.{1,2}\/[^"']+\.js)\2/g;
const DYNAMIC_IMPORT_PATTERN = /\bimport\s*\(\s*(["'])(\.{1,2}\/[^"']+\.js)\1\s*\)/g;
const LOADER_REGISTRY = "__pyobservablejsModuleLoaders";
const COMMAND_FALLBACK_DELAY_MS = 250;
const MODULE_TIMEOUT_MS = 30_000;

type ModuleResponse = {
	seq?: unknown;
	path?: unknown;
	source?: unknown;
	error?: unknown;
};

export type WidgetApp = {
	initialize?: (props: InitializeProps<WidgetModel> & { signal?: AbortSignal }) => void | Promise<void>;
	render: (props: RenderProps<WidgetModel> & { signal?: AbortSignal }) => void | Promise<void>;
};

type ModuleState = {
	id: string;
	nextSeq: number;
	modules: Map<string, Promise<unknown>>;
	requestQueue: Promise<void>;
	urls: Map<string, Promise<string>>;
};

type ModuleLoaderOptions = {
	createModuleUrl?: (source: string, path: string) => string;
	importModule?: (url: string) => Promise<unknown>;
	invoke?: Experimental["invoke"];
};

const states = new WeakMap<WidgetAnyModel, ModuleState>();

export async function loadWidgetApp(
	model: WidgetAnyModel,
	path: string,
	signal: AbortSignal,
	options: ModuleLoaderOptions = {},
): Promise<WidgetApp> {
	const state = stateFor(model);
	registerDynamicLoader(model, state, signal, options);
	const module = await importModule(model, state, path, signal, options);
	const app = moduleValue(module);
	if (!isWidgetApp(app)) throw new Error("Widget app module does not export a render function");
	return app;
}

async function importModule(
	model: WidgetAnyModel,
	state: ModuleState,
	path: string,
	signal: AbortSignal,
	options: ModuleLoaderOptions,
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
	model: WidgetAnyModel,
	state: ModuleState,
	path: string,
	signal: AbortSignal,
	options: ModuleLoaderOptions,
): Promise<string> {
	const existing = state.urls.get(path);
	if (existing) return existing;
	const nextUrl = createModuleUrl(model, state, path, signal, options);
	state.urls.set(path, nextUrl);
	return nextUrl;
}

async function createModuleUrl(
	model: WidgetAnyModel,
	state: ModuleState,
	path: string,
	signal: AbortSignal,
	options: ModuleLoaderOptions,
): Promise<string> {
	const source = await readModuleSource(model, state, path, signal, options);
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
	model: WidgetAnyModel,
	state: ModuleState,
	path: string,
	signal: AbortSignal,
	options: ModuleLoaderOptions,
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
	model: WidgetAnyModel,
	state: ModuleState,
	path: string,
	signal: AbortSignal,
	options: ModuleLoaderOptions,
): Promise<string> {
	if (signal.aborted) throw new DOMException("Widget module request aborted", "AbortError");
	if (options.invoke === undefined) return await readModuleSourceViaTraitlet(model, state, path, signal);
	const transportController = new AbortController();
	const transportSignal = AbortSignal.any([signal, transportController.signal]);
	const traitletSource = readModuleSourceViaTraitlet(model, state, path, transportSignal);
	const commandSource = delay(COMMAND_FALLBACK_DELAY_MS, transportSignal).then(async () => {
		const source = await readModuleSourceViaCommand(path, transportSignal, options.invoke);
		return source === undefined ? traitletSource : source;
	});
	try {
		return await Promise.race([traitletSource, commandSource]);
	} finally {
		transportController.abort();
	}
}

function readModuleSourceViaTraitlet(
	model: WidgetAnyModel,
	state: ModuleState,
	path: string,
	signal: AbortSignal,
): Promise<string> {
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
			finish(() => reject(new DOMException("Widget module request aborted", "AbortError")));
		};
		const onResponse = () => {
			const response = model.get(RESPONSE_TRAIT) as ModuleResponse | undefined;
			if (!response || response.seq !== seq) return;
			finish(() => {
				try {
					resolve(moduleSourceFromResponse(response, path));
				} catch (error) {
					reject(error);
				}
			});
		};
		model.on?.(`change:${RESPONSE_TRAIT}`, onResponse);
		signal.addEventListener("abort", onAbort, { once: true });
		timeout = window.setTimeout(() => {
			finish(() => reject(new Error(`Timed out loading widget module ${path}`)));
		}, MODULE_TIMEOUT_MS);
		model.set(REQUEST_TRAIT, { seq, path });
		model.save_changes?.();
		onResponse();
	});
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(new DOMException("Widget module request aborted", "AbortError"));
	return new Promise((resolve, reject) => {
		const timeout = window.setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				window.clearTimeout(timeout);
				reject(new DOMException("Widget module request aborted", "AbortError"));
			},
			{ once: true },
		);
	});
}

async function readModuleSourceViaCommand(
	path: string,
	signal: AbortSignal,
	invoke: Experimental["invoke"] | undefined,
): Promise<string | undefined> {
	if (invoke === undefined) return undefined;
	try {
		const [response] = await invoke<ModuleResponse>("read_esm_module", { path }, { signal });
		return moduleSourceFromResponse(response, path);
	} catch (error) {
		if (!isUnsupportedInvokeError(error)) throw error;
		return undefined;
	}
}

function moduleSourceFromResponse(response: ModuleResponse, path: string): string {
	if (response.error !== undefined) throw new Error(String(response.error));
	if (response.path !== path) throw new Error(`Widget module response path mismatch: ${String(response.path)}`);
	if (typeof response.source !== "string") throw new Error(`Widget module ${path} did not return source text`);
	return response.source;
}

function isUnsupportedInvokeError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return /invoke not supported|not supported in marimo/i.test(error.message);
}

function stateFor(model: WidgetAnyModel): ModuleState {
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
	model: WidgetAnyModel,
	state: ModuleState,
	signal: AbortSignal,
	options: ModuleLoaderOptions,
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
		__pyobservablejsModuleLoaders?: Record<string, (path: string) => Promise<unknown>>;
	};
	return (global.__pyobservablejsModuleLoaders ??= {});
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

function isWidgetApp(value: unknown): value is WidgetApp {
	return value !== null && typeof value === "object" && typeof (value as { render?: unknown }).render === "function";
}
