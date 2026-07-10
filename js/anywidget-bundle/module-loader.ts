import { init, parse, type ImportSpecifier } from "es-module-lexer/minimal";
import { isJavaScriptArtifactPath } from "./artifact-path";
import { createBundleId } from "./id";
import type { ModuleReader } from "./protocol";

// Blob modules have no package-relative route back to this loader. Rewritten
// relative dynamic imports use this registry for the owning model graph.
const LOADER_REGISTRY = "anywidget-bundle.loaders.v1";
const STATIC_IMPORT = 1;
const DYNAMIC_IMPORT = 2;
const IMPORT_META = 3;

type LoaderRegistry = Map<string, (path: string) => Promise<unknown>>;

type ModuleLoaderState = {
	id: string;
	signal: AbortSignal;
	reader: ModuleReader;
	modules: Map<string, Promise<unknown>>;
	sources: Map<string, Promise<ParsedModule>>;
	urls: Map<string, string>;
	moduleUrls: Set<string>;
	buildQueue: Promise<void>;
	disposed: boolean;
	options: ModuleLoaderOptions;
};

type ParsedModule = {
	source: string;
	imports: readonly ImportSpecifier[];
};

type Replacement = {
	start: number;
	end: number;
	value: string;
};

export type ModuleLoaderOptions = {
	createModuleUrl?: (source: string, path: string) => string;
	importModule?: (url: string) => Promise<unknown>;
	revokeModuleUrl?: (url: string) => void;
};

export type ModuleLoader = {
	import(path: string): Promise<unknown>;
	dispose(): void;
};

export function createModuleLoader(
	reader: ModuleReader,
	signal: AbortSignal,
	options: ModuleLoaderOptions = {},
): ModuleLoader {
	const state: ModuleLoaderState = {
		id: createBundleId(),
		signal,
		reader,
		modules: new Map(),
		sources: new Map(),
		urls: new Map(),
		moduleUrls: new Set(),
		buildQueue: Promise.resolve(),
		disposed: false,
		options,
	};
	const registry = moduleLoaderRegistry();
	const load = (path: string) => importModule(state, path);
	registry.set(state.id, load);

	const dispose = () => {
		if (state.disposed) return;
		state.disposed = true;
		signal.removeEventListener("abort", dispose);
		if (registry.get(state.id) === load) registry.delete(state.id);
		// Imported modules retain these URLs for shared and deferred imports, so
		// URLs stay live until the loader lifecycle ends.
		for (const url of state.moduleUrls) revokeUrl(state, url);
		state.moduleUrls.clear();
		state.urls.clear();
		state.sources.clear();
		state.modules.clear();
	};

	signal.addEventListener("abort", dispose, { once: true });
	if (signal.aborted) dispose();

	return { import: load, dispose };
}

async function importModule(state: ModuleLoaderState, path: string): Promise<unknown> {
	assertActive(state);
	const modulePath = normalizeModulePath(path);
	const existing = state.modules.get(modulePath);
	if (existing) return existing;
	const next = enqueueModuleUrl(state, modulePath).then((url) => {
		assertActive(state);
		return (state.options.importModule ?? importModuleUrl)(url);
	});
	state.modules.set(modulePath, next);
	try {
		return await next;
	} catch (error) {
		// Drop the module, URL, and parsed source together so transient transport,
		// parsing, or evaluation failures can retry cleanly.
		if (state.modules.get(modulePath) === next) state.modules.delete(modulePath);
		discardUrl(state, modulePath);
		state.sources.delete(modulePath);
		throw error;
	}
}

function enqueueModuleUrl(state: ModuleLoaderState, path: string): Promise<string> {
	const existing = state.urls.get(path);
	if (existing) return Promise.resolve(existing);
	// Serialize graph construction so concurrent roots share one URL and one ESM
	// instance for each module path.
	const result = state.buildQueue.then(() => createModuleUrl(state, path, []));
	state.buildQueue = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}

async function createModuleUrl(state: ModuleLoaderState, path: string, ancestors: readonly string[]): Promise<string> {
	assertActive(state);
	const existing = state.urls.get(path);
	if (existing) return existing;
	if (ancestors.includes(path)) {
		throw new Error(`Static anywidget bundle import cycle: ${[...ancestors, path].join(" -> ")}`);
	}
	// Blob source needs concrete URLs for static dependencies before its own URL
	// can be created. This dependency-first order also makes static cycles invalid.
	const parsed = await readParsedModule(state, path);
	const nextAncestors = [...ancestors, path];
	const dependencyUrls = new Map<string, string>();
	await loadStaticDependencies(state, parsed.imports, path, nextAncestors, dependencyUrls);
	const source = rewriteImports(parsed, path, state.id, dependencyUrls);
	assertActive(state);
	const url = createUrl(state, source, path);
	state.urls.set(path, url);
	return url;
}

async function loadStaticDependencies(
	state: ModuleLoaderState,
	imports: readonly ImportSpecifier[],
	path: string,
	ancestors: readonly string[],
	urls: Map<string, string>,
	index = 0,
): Promise<void> {
	// URL cache entries appear after a module is fully rewritten. Walk siblings
	// sequentially so branches sharing a dependency cannot mint duplicate URLs.
	const record = imports[index];
	if (!record) return;
	if (isStaticImport(record) && record.n !== undefined && isRelativeImport(record.n)) {
		const dependencyPath = importPath(path, record);
		if (!urls.has(dependencyPath)) {
			urls.set(dependencyPath, await createModuleUrl(state, dependencyPath, ancestors));
		}
	}
	await loadStaticDependencies(state, imports, path, ancestors, urls, index + 1);
}

async function readParsedModule(state: ModuleLoaderState, path: string): Promise<ParsedModule> {
	const existing = state.sources.get(path);
	if (existing) return existing;
	const next = state.reader.read(path).then(async (source) => {
		await init;
		const [imports] = parse(source, path);
		validateImports(path, imports);
		return { source, imports };
	});
	state.sources.set(path, next);
	try {
		return await next;
	} catch (error) {
		if (state.sources.get(path) === next) state.sources.delete(path);
		throw error;
	}
}

function validateImports(path: string, imports: readonly ImportSpecifier[]): void {
	for (const record of imports) {
		if (record.t === IMPORT_META) continue;
		if (record.t !== STATIC_IMPORT && record.t !== DYNAMIC_IMPORT) {
			throw new Error(`Unsupported import syntax in anywidget bundle module ${path}.`);
		}
		if (record.t === DYNAMIC_IMPORT && record.n === undefined) continue;
		if (record.n === undefined || (!isRelativeImport(record.n) && !isUrlImport(record.n))) {
			throw new Error(`Unsupported import in anywidget bundle module ${path}.`);
		}
		if (isRelativeImport(record.n)) resolveRelativePath(path, record.n);
	}
}

function rewriteImports(
	parsed: ParsedModule,
	path: string,
	loaderId: string,
	dependencyUrls: ReadonlyMap<string, string>,
): string {
	// Literal relative dynamic imports re-enter this loader. URL and computed
	// dynamic imports remain native browser imports.
	const replacements: Replacement[] = [];
	for (const record of parsed.imports) {
		if (record.t === IMPORT_META) continue;
		if (record.n === undefined || !isRelativeImport(record.n)) continue;
		const dependencyPath = importPath(path, record);
		if (isStaticImport(record)) {
			const url = dependencyUrls.get(dependencyPath);
			if (!url) throw new Error(`Could not resolve bundle module ${dependencyPath}.`);
			replacements.push({ start: record.s, end: record.e, value: url });
		} else {
			replacements.push({
				start: record.ss,
				end: record.se,
				value: dynamicImportExpression(loaderId, dependencyPath),
			});
		}
	}
	return applyReplacements(parsed.source, replacements);
}

function applyReplacements(source: string, replacements: readonly Replacement[]): string {
	let result = source;
	// Apply edits right to left so earlier lexer offsets remain valid.
	for (const replacement of [...replacements].sort((left, right) => right.start - left.start)) {
		result = `${result.slice(0, replacement.start)}${replacement.value}${result.slice(replacement.end)}`;
	}
	return result;
}

function importPath(path: string, record: ImportSpecifier): string {
	if (record.n === undefined) throw new Error(`Unsupported import in anywidget bundle module ${path}.`);
	return resolveRelativePath(path, record.n);
}

function isStaticImport(record: ImportSpecifier): boolean {
	return record.t === STATIC_IMPORT;
}

function isRelativeImport(specifier: string): boolean {
	return specifier.startsWith("./") || specifier.startsWith("../");
}

function isUrlImport(specifier: string): boolean {
	return specifier.startsWith("https://") || specifier.startsWith("http://");
}

function resolveRelativePath(path: string, specifier: string): string {
	const parts: string[] = [];
	for (const part of [...path.split("/").slice(0, -1), ...specifier.split("/")]) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (parts.length === 0) {
				throw new Error(`Anywidget bundle import escapes the bundle root: ${specifier}`);
			}
			parts.pop();
		} else {
			parts.push(part);
		}
	}
	return normalizeModulePath(parts.join("/"));
}

function normalizeModulePath(path: string): string {
	if (!isJavaScriptArtifactPath(path)) {
		throw new Error(`Unsupported anywidget bundle module path: ${path}`);
	}
	return path;
}

function createUrl(state: ModuleLoaderState, source: string, path: string): string {
	const url = state.options.createModuleUrl
		? state.options.createModuleUrl(source, path)
		: URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
	state.moduleUrls.add(url);
	return url;
}

function discardUrl(state: ModuleLoaderState, path: string): void {
	const url = state.urls.get(path);
	if (!url) return;
	state.urls.delete(path);
	if (state.moduleUrls.delete(url)) revokeUrl(state, url);
}

function revokeUrl(state: ModuleLoaderState, url: string): void {
	(state.options.revokeModuleUrl ?? URL.revokeObjectURL)(url);
}

function moduleLoaderRegistry(): LoaderRegistry {
	const global = globalThis as typeof globalThis & {
		[LOADER_REGISTRY_SYMBOL]?: LoaderRegistry;
	};
	return (global[LOADER_REGISTRY_SYMBOL] ??= new Map());
}

const LOADER_REGISTRY_SYMBOL = Symbol.for(LOADER_REGISTRY);

function dynamicImportExpression(loaderId: string, path: string): string {
	return `globalThis[Symbol.for(${JSON.stringify(LOADER_REGISTRY)})].get(${JSON.stringify(loaderId)})(${JSON.stringify(path)})`;
}

function assertActive(state: ModuleLoaderState): void {
	if (state.disposed || state.signal.aborted) {
		throw new DOMException("Anywidget bundle module request aborted", "AbortError");
	}
}

async function importModuleUrl(url: string): Promise<unknown> {
	return await import(/* @vite-ignore */ url);
}
