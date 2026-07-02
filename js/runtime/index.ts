import type { Cell } from "@observablehq/notebook-kit";
import { FileAttachment, NotebookRuntime, library, registerFile } from "@observablehq/notebook-kit/runtime";
import { exposedVariableNames, unprefix, type RuntimeCellDefinition } from "./graph";
import { bindRuntimeScope, cleanupRuntimeScope, createRuntimeScope } from "./scope";
import { createVariableBuiltins } from "./values";

export type AttachmentInfo = {
	url: string;
	mimeType?: string;
	lastModified?: number;
	size?: number;
};

export type NotebookOptions = {
	attachments: Record<string, AttachmentInfo>;
	baseUrl: string;
	variables: Record<string, unknown>;
	showSource: boolean;
};

export type AttachmentRegistry = {
	baseUrl: string;
	names: Set<string>;
	blobUrls: Map<string, string>;
	disposed: boolean;
	cleanup(): void;
};

export type { NestedSelectState, RuntimeVariablesSync, ViewTarget, ViewWriteResult } from "./values";
export { runtimeDocument } from "./scope";
export {
	createVariableBuiltins,
	isWritableSyncedViewValue,
	isViewTarget,
	readNestedSelectState,
	readViewValue,
	revivePythonValue,
	reviveSyncedValue,
	sameWireValue,
	toWireValue,
	writeViewValue,
} from "./values";

type RuntimeBuiltins = NonNullable<ConstructorParameters<typeof NotebookRuntime>[0]>;
type RuntimeBuiltinsWithVars = RuntimeBuiltins & Record<string, () => unknown>;
export type RuntimeGlobals = {
	document?: Document;
};
export type RuntimeDefinitionOptions = RuntimeGlobals & {
	notebookNames?: ReadonlySet<string>;
};
type HtmlTemplateTag = (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
type LegacyRequire = {
	(...specifiers: unknown[]): Promise<unknown>;
	resolve(specifier: unknown): string;
	alias(aliases: Record<string, string>): LegacyRequire;
};
type NpmSpecifier = {
	name: string;
	range: string;
	path: string;
};
type RuntimeFileAttachment = ReturnType<typeof FileAttachment> & {
	sqlite(): Promise<SQLiteDatabaseClient>;
};
type RuntimeFileAttachmentFactory = {
	(name: string, base?: string): RuntimeFileAttachment;
	prototype: typeof FileAttachment.prototype;
};
type RuntimeFileResolver = (name: string) => { url: string; mimeType?: string } | string | null;
type RuntimeFileAttachments = (resolve: RuntimeFileResolver) => (name: string) => ReturnType<typeof FileAttachment>;
type SqlJsDatabase = {
	exec(query: string, params?: unknown[]): SqlJsResult[];
};
type SqlJsResult = {
	columns: string[];
	values: unknown[][];
};
type SqlJsModule = {
	Database: new (data?: Uint8Array) => SqlJsDatabase;
};
type SqlJsInit = (options: { locateFile(name: string): string }) => Promise<SqlJsModule>;
type SQLiteRows = Record<string, unknown>[] & { columns?: string[]; value?: SQLiteRows };
type SQLiteGlobalConfig = {
	initSqlJs?: SqlJsInit;
	locateFile?(name: string): string;
};

const RESERVED_RUNTIME_NAMES = new Set([
	...Object.keys(library),
	"DuckDBClient",
	"FileAttachment",
	"Generators",
	"SQLite",
	"SQLiteDatabaseClient",
	"document",
	"require",
	"width",
]);
const legacyRequireModuleCache = new WeakMap<object, unknown>();
const legacyRequire = Object.assign(createLegacyRequire(resolveLegacyRequire), { alias: legacyRequireAlias });
let sqliteModule: Promise<SqlJsModule> | undefined;
let htmlBuiltin: Promise<HtmlTemplateTag> | undefined;

export function createRuntime(
	root: HTMLElement,
	el: HTMLElement,
	options: NotebookOptions,
	attachmentRegistry: AttachmentRegistry,
): NotebookRuntime {
	// Python variables enter OJS as Observable builtins before Notebook Kit defines cells.
	const collisions = runtimeBuiltinCollisions(options.variables);
	if (collisions.length > 0)
		throw new Error(`Python variables cannot override Observable runtime builtins: ${collisions.join(", ")}`);
	const width = () => observeWidth(root, el);
	const scope = createRuntimeScope(root);
	const builtins = {
		...library,
		DuckDBClient: () =>
			Promise.resolve((library.DuckDBClient as () => unknown)()).then((DuckDBClient) =>
				createDuckDBClient(DuckDBClient as object, attachmentRegistry),
			),
		FileAttachment: () => createFileAttachment(options.baseUrl, attachmentRegistry),
		Generators: () => createGenerators(library.Generators()),
		html: () => loadHtmlBuiltin(),
		Mutable: () => ObservableMutable,
		SQLite: () => loadSQLiteModule(),
		SQLiteDatabaseClient: () => SQLiteDatabaseClient,
		document: () => scope.document,
		require: () => legacyRequire,
		width: width as RuntimeBuiltins["width"],
		...createVariableBuiltins(options.variables),
	} as RuntimeBuiltinsWithVars;
	const runtime = new NotebookRuntime(builtins);
	extendRuntimeFileAttachments(runtime);
	bindRuntimeScope(runtime, scope);
	return runtime;
}

function runtimeBuiltinCollisions(variables: Record<string, unknown>): string[] {
	return Object.keys(variables)
		.filter((name) => RESERVED_RUNTIME_NAMES.has(name))
		.sort();
}

function extendRuntimeFileAttachments(runtime: NotebookRuntime): void {
	const runtimeWithFiles = runtime.runtime as NotebookRuntime["runtime"] & {
		fileAttachments?: RuntimeFileAttachments;
	};
	const fileAttachments = runtimeWithFiles.fileAttachments;
	if (typeof fileAttachments !== "function") return;
	runtimeWithFiles.fileAttachments = (resolve: RuntimeFileResolver) => {
		const FileAttachment = fileAttachments(resolve);
		const wrapped = ((name: string) => withSQLiteFileAttachment(FileAttachment(name))) as ReturnType<
			typeof fileAttachments
		>;
		wrapped.prototype = FileAttachment.prototype;
		return wrapped;
	};
}

function observeWidth(root: HTMLElement, fallback: HTMLElement): AsyncGenerator<number, void, unknown> {
	return observe((notify) => {
		let width: number | undefined;
		const update = (value = currentWidth(root, fallback)) => {
			const next = Math.max(320, Math.floor(value || 928));
			if (next !== width) notify((width = next));
		};
		update();
		if (typeof ResizeObserver === "undefined") return undefined;
		const observer = new ResizeObserver(([entry]) => update(entry?.contentRect.width));
		observer.observe(root);
		return () => observer.disconnect();
	});
}

function observe<T>(
	initialize: (notify: (value: T) => T) => (() => void) | undefined,
): AsyncGenerator<T, void, unknown> {
	let resolve: ((value: T) => void) | undefined;
	let reject: ((error: unknown) => void) | undefined;
	let value: T;
	let stale = false;
	const dispose = initialize((next) => {
		value = next;
		if (resolve) {
			resolve(next);
			resolve = undefined;
			reject = undefined;
		} else {
			stale = true;
		}
		return next;
	});
	return {
		async next() {
			return {
				done: false,
				value: await (stale
					? ((stale = false), value)
					: new Promise<T>((res, rej) => {
							resolve = res;
							reject = rej;
						})),
			};
		},
		async return() {
			reject?.(new Error("Generator returned"));
			resolve = undefined;
			reject = undefined;
			dispose?.();
			return { done: true, value: undefined };
		},
		async throw(error) {
			reject?.(error);
			resolve = undefined;
			reject = undefined;
			dispose?.();
			return { done: true, value: undefined };
		},
		[Symbol.asyncIterator]() {
			return this;
		},
	};
}

function currentWidth(root: HTMLElement, fallback: HTMLElement): number {
	return root.getBoundingClientRect().width || fallback.clientWidth || 928;
}

function createLegacyRequire(resolve: (specifier: unknown) => string): LegacyRequire {
	const require = (async (...specifiers: unknown[]) => {
		if (specifiers.length === 1) return import(/* @vite-ignore */ resolve(specifiers[0])).then(objectifyModule);
		return Promise.all(specifiers.map((specifier) => require(specifier))).then(mergeModules);
	}) as LegacyRequire;
	require.resolve = resolve;
	require.alias = legacyRequireAlias;
	return require;
}

function legacyRequireAlias(aliases: Record<string, string>): LegacyRequire {
	return createLegacyRequire((specifier) => resolveLegacyRequire(aliases[String(specifier)] ?? specifier));
}

function resolveLegacyRequire(specifier: unknown): string {
	const value = String(specifier);
	if (isProtocol(value) || isLocal(value)) return value;
	const { name, range, path } = parseNpmSpecifier(value);
	const suffix = (isFile(path) && !isJavaScript(path)) || isDirectory(path) ? "" : "/+esm";
	return `https://cdn.jsdelivr.net/npm/${name}${range}${path}${suffix}`;
}

function parseNpmSpecifier(specifier: string): NpmSpecifier {
	const parts = specifier.split("/");
	const namerange = specifier.startsWith("@") ? [parts.shift()!, parts.shift()!].join("/") : parts.shift()!;
	const ranged = namerange.indexOf("@", 1);
	const name = ranged > 0 ? namerange.slice(0, ranged) : namerange;
	const range = ranged > 0 ? namerange.slice(ranged) : "";
	const path = parts.length > 0 ? `/${parts.join("/")}` : "";
	return { name, range, path };
}

function objectifyModule(module: object): unknown {
	if (legacyRequireModuleCache.has(module)) return legacyRequireModuleCache.get(module);
	const object = defaultifyModule(module);
	legacyRequireModuleCache.set(module, object);
	return object;
}

function defaultifyModule(module: object): unknown {
	for (const key in module) if (key !== "default") return { ...module };
	return "default" in module ? module.default : { ...module };
}

function mergeModules(modules: unknown[]): unknown {
	return Object.assign({}, ...modules);
}

function isProtocol(specifier: string): boolean {
	return /^\w+:/.test(specifier);
}

function isLocal(specifier: string): boolean {
	return /^(\.\/|\.\.\/|\/)/.test(specifier);
}

function isJavaScript(specifier: string): boolean {
	return /\.js$/i.test(specifier);
}

function isFile(specifier: string): boolean {
	return /\.\w*$/.test(specifier);
}

function isDirectory(specifier: string): boolean {
	return specifier.endsWith("/");
}

type RedefinableModule = NotebookRuntime["main"] & {
	define(name: string, inputs: string[], definition: () => unknown): unknown;
	redefine(name: string, inputs: string[], definition: () => unknown): unknown;
};

export function redefineRuntimeVariables(runtime: NotebookRuntime, variables: Record<string, unknown>): void {
	const definitions = createVariableBuiltins(variables);
	for (const [name, define] of Object.entries(definitions)) {
		try {
			(runtime.main as RedefinableModule).redefine(name, [], define);
		} catch (error) {
			if (!isUnknownRuntimeVariable(error, name)) throw error;
		}
	}
}

export function setRuntimeVariables(runtime: NotebookRuntime, variables: Record<string, unknown>): void {
	const definitions = createVariableBuiltins(variables);
	for (const [name, define] of Object.entries(definitions)) {
		try {
			(runtime.main as RedefinableModule).redefine(name, [], define);
		} catch (error) {
			if (!isUnknownRuntimeVariable(error, name)) throw error;
			(runtime.main as RedefinableModule).define(name, [], define);
		}
	}
}

function isUnknownRuntimeVariable(error: unknown, name: string): boolean {
	return error instanceof Error && error.message === `${name} is not defined`;
}

export function createRuntimeCleanup(runtime: NotebookRuntime, attachmentRegistry: AttachmentRegistry): () => void {
	let disposed = false;
	return () => {
		if (disposed) return;
		disposed = true;
		cleanupRuntimeScope(runtime);
		runtime.runtime.dispose();
		attachmentRegistry.cleanup();
	};
}

export function createFileAttachment(baseUrl: string, registry: AttachmentRegistry): RuntimeFileAttachmentFactory {
	// A synthetic base URL scopes registered attachments to this widget instance.
	const attachment = ((name: string, base?: string) => {
		const key = String(name);
		if (base !== undefined) return withSQLiteFileAttachment(FileAttachment(key, base));
		const decoded = safeDecodeURI(key);
		const registered = registry.names.has(key) ? key : decoded && registry.names.has(decoded) ? decoded : null;
		return withSQLiteFileAttachment(
			FileAttachment(registered ?? key, registered ? registry.baseUrl : baseUrl || document.baseURI),
		);
	}) as RuntimeFileAttachmentFactory;
	attachment.prototype = FileAttachment.prototype;
	return attachment;
}

function withSQLiteFileAttachment(file: ReturnType<typeof FileAttachment>): RuntimeFileAttachment {
	if ("sqlite" in file && typeof file.sqlite === "function") return file as RuntimeFileAttachment;
	return new Proxy(file, {
		get(target, property, receiver) {
			if (property === "sqlite") return () => SQLiteDatabaseClient.open(target);
			return Reflect.get(target, property, receiver);
		},
	}) as RuntimeFileAttachment;
}

export class SQLiteDatabaseClient {
	constructor(private readonly db: SqlJsDatabase) {}

	static async open(source: unknown): Promise<SQLiteDatabaseClient> {
		const [sqlite, data] = await Promise.all([loadSQLiteModule(), loadSQLiteSource(source)]);
		return new SQLiteDatabaseClient(new sqlite.Database(data));
	}

	async query(query: string, params?: unknown[]): Promise<SQLiteRows> {
		return execSQLite(this.db, query, params);
	}

	async queryRow(query: string, params?: unknown[]): Promise<Record<string, unknown> | null> {
		return (await this.query(query, params))[0] ?? null;
	}

	async describeTables({ schema }: { schema?: string } = {}): Promise<SQLiteRows> {
		return this.query(
			`SELECT NULLIF(schema, 'main') AS schema, name FROM pragma_table_list() WHERE type = 'table'${
				schema == null ? "" : " AND schema = ?"
			} AND name NOT LIKE 'sqlite_%' ORDER BY schema, name`,
			schema == null ? [] : [schema],
		);
	}

	async describeColumns({ schema, table }: { schema?: string; table?: string } = {}): Promise<SQLiteRows> {
		if (table == null) throw new Error("missing table");
		const rows = await this.query(
			`SELECT name, type, "notnull" FROM pragma_table_info(?${schema == null ? "" : ", ?"}) ORDER BY cid`,
			schema == null ? [table] : [table, schema],
		);
		if (!rows.length) throw new Error(`table not found: ${table}`);
		return withSQLiteRowsValue(
			rows.map(({ name, type, notnull }) => ({
				name,
				type: sqliteType(String(type)),
				databaseType: type,
				nullable: !notnull,
			})) as SQLiteRows,
		);
	}

	async describe(table?: string): Promise<SQLiteRows> {
		return table == null ? this.describeTables() : this.describeColumns({ table });
	}

	async sql(strings: TemplateStringsArray, ...params: unknown[]): Promise<SQLiteRows> {
		return this.query(...this.queryTag(strings, ...params));
	}

	queryTag(strings: TemplateStringsArray, ...params: unknown[]): [string, unknown[]] {
		return [strings.join("?"), params];
	}
}

Object.defineProperty(SQLiteDatabaseClient.prototype, "dialect", { value: "sqlite" });

async function loadSQLiteModule(): Promise<SqlJsModule> {
	if (sqliteModule !== undefined) return sqliteModule;
	const config = (globalThis as { observablejsSqlite?: SQLiteGlobalConfig }).observablejsSqlite;
	const init = config?.initSqlJs ?? (globalThis as { initSqlJs?: SqlJsInit }).initSqlJs;
	if (init === undefined) {
		throw new Error("SQLite requires a caller-provided sql.js initSqlJs loader");
	}
	const nextModule = init({
		locateFile: (name) => config?.locateFile?.(name) ?? name,
	});
	const guarded = nextModule.catch((error) => {
		if (sqliteModule === guarded) sqliteModule = undefined;
		throw error;
	});
	sqliteModule = guarded;
	return guarded;
}

async function loadSQLiteSource(source: unknown): Promise<Uint8Array> {
	if (typeof source === "string") return fetch(source).then(loadSQLiteSource);
	if (isArrayBufferSource(source)) return source.arrayBuffer().then(loadSQLiteSource);
	if (source instanceof ArrayBuffer) return new Uint8Array(source);
	if (source instanceof Uint8Array) return source;
	return source as Uint8Array;
}

function isArrayBufferSource(value: unknown): value is { arrayBuffer(): Promise<ArrayBuffer> } {
	return (
		typeof value === "object" && value !== null && "arrayBuffer" in value && typeof value.arrayBuffer === "function"
	);
}

function execSQLite(db: SqlJsDatabase, query: string, params?: unknown[]): SQLiteRows {
	const [result] = db.exec(query, params);
	if (!result) return withSQLiteRowsValue([] as SQLiteRows);
	const rows = result.values.map((row) =>
		Object.fromEntries(row.map((value, index) => [result.columns[index], value])),
	) as SQLiteRows;
	rows.columns = result.columns;
	return withSQLiteRowsValue(rows);
}

function withSQLiteRowsValue(rows: SQLiteRows): SQLiteRows {
	Object.defineProperty(rows, "value", { configurable: true, value: rows });
	return rows;
}

function sqliteType(type: string): string {
	switch (type) {
		case "NULL":
			return "null";
		case "INT":
		case "INTEGER":
		case "TINYINT":
		case "SMALLINT":
		case "MEDIUMINT":
		case "BIGINT":
		case "UNSIGNED BIG INT":
		case "INT2":
		case "INT8":
			return "integer";
		case "TEXT":
		case "CLOB":
			return "string";
		case "REAL":
		case "DOUBLE":
		case "DOUBLE PRECISION":
		case "FLOAT":
		case "NUMERIC":
			return "number";
		case "BLOB":
			return "buffer";
		case "DATE":
		case "DATETIME":
			return "string";
		default:
			if (/^(?:(?:(?:VARYING|NATIVE) )?CHARACTER|(?:N|VAR|NVAR)CHAR)\(/.test(type)) return "string";
			if (/^(?:DECIMAL|NUMERIC)\(/.test(type)) return "number";
			return "other";
	}
}

export function createDuckDBClient<T extends object>(DuckDBClient: T, registry: AttachmentRegistry): T {
	return new Proxy(DuckDBClient, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver);
			if ((property === "of" || property === "sql") && typeof value === "function") {
				return (...args: unknown[]) => value.apply(target, wrapDuckDBArgs(args, registry));
			}
			return value;
		},
	});
}

export function createGenerators<T extends object>(Generators: T): T {
	return new Proxy(Generators, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver);
			if ((property === "observe" || property === "queue") && typeof value === "function") {
				return (...args: unknown[]) => syncIterableAsyncGenerator(value.apply(target, args));
			}
			return value;
		},
	});
}

function syncIterableAsyncGenerator<T>(value: T): T {
	if (!isAsyncGenerator(value) || Symbol.iterator in value) return value;
	return new Proxy(value, {
		get(target, property, receiver) {
			if (property === Symbol.iterator) return () => syncIteratorFromAsyncGenerator(target);
			return Reflect.get(target, property, receiver);
		},
	});
}

function syncIteratorFromAsyncGenerator<T>(generator: AsyncGenerator<T>): Iterator<Promise<T | undefined>> {
	return {
		next() {
			return {
				done: false,
				value: generator.next().then((result) => result.value),
			};
		},
		return() {
			void generator.return(undefined);
			return { done: true, value: undefined };
		},
	};
}

function isAsyncGenerator(value: unknown): value is AsyncGenerator<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as AsyncGenerator<unknown>).next === "function" &&
		typeof (value as AsyncGenerator<unknown>)[Symbol.asyncIterator] === "function"
	);
}

function wrapDuckDBArgs(args: unknown[], registry: AttachmentRegistry): unknown[] {
	if (args.length === 0) return args;
	const [sources, ...rest] = args;
	if (Array.isArray(sources)) return [wrapDuckDBSourceEntries(sources, registry), ...rest];
	if (isFileAttachmentLike(sources)) {
		return [{ [attachmentTableName(sources.name)]: withDuckDBAttachmentUrl(sources, registry) }, ...rest];
	}
	return [wrapDuckDBSources(sources, registry), ...rest];
}

function wrapDuckDBSources(sources: unknown, registry: AttachmentRegistry): unknown {
	if (!isPlainObject(sources)) return sources;
	return Object.fromEntries(
		Object.entries(sources).map(([name, source]) => [name, wrapDuckDBSource(source, registry)]),
	);
}

function wrapDuckDBSourceEntries(sources: unknown[], registry: AttachmentRegistry): Record<string, unknown> {
	const entries = sources.map((source) => duckDBSourceEntry(source, registry));
	return Object.fromEntries(entries.filter((entry) => entry !== undefined));
}

function duckDBSourceEntry(source: unknown, registry: AttachmentRegistry): [string, unknown] | undefined {
	if (Array.isArray(source) && typeof source[0] === "string" && source.length >= 2) {
		return [source[0], wrapDuckDBSource(source[1], registry)];
	}
	if (isFileAttachmentLike(source)) {
		return [attachmentTableName(source.name), withDuckDBAttachmentUrl(source, registry)];
	}
	if (isPlainObject(source) && isFileAttachmentLike(source.file)) {
		const name = typeof source.name === "string" && source.name ? source.name : attachmentTableName(source.file.name);
		return [name, wrapDuckDBSource(source, registry)];
	}
	return undefined;
}

function wrapDuckDBSource(source: unknown, registry: AttachmentRegistry): unknown {
	if (isFileAttachmentLike(source)) return withDuckDBAttachmentUrl(source, registry);
	if (isPlainObject(source) && isFileAttachmentLike(source.file)) {
		return { ...source, file: withDuckDBAttachmentUrl(source.file, registry) };
	}
	return source;
}

function withDuckDBAttachmentUrl(file: ReturnType<typeof FileAttachment>, registry: AttachmentRegistry): typeof file {
	return new Proxy(file, {
		get(target, property, receiver) {
			if (property === "url") return () => registeredBlobUrl(target, registry);
			return Reflect.get(target, property, receiver);
		},
	});
}

function isFileAttachmentLike(value: unknown): value is ReturnType<typeof FileAttachment> {
	return (
		typeof value === "object" &&
		value !== null &&
		"name" in value &&
		"url" in value &&
		"blob" in value &&
		typeof value.name === "string" &&
		typeof value.url === "function" &&
		typeof value.blob === "function"
	);
}

function loadHtmlBuiltin(): Promise<HtmlTemplateTag> {
	return (htmlBuiltin ??= Promise.resolve((library.html as () => unknown)()).then((html) =>
		createObservableHtml(html as HtmlTemplateTag),
	));
}

export function createObservableHtml(html: HtmlTemplateTag): HtmlTemplateTag {
	return (strings, ...values) =>
		finalizeObservableHtmlResult(html(strings, ...values.map(coerceObservableHtmlValue)), strings);
}

function finalizeObservableHtmlResult(value: unknown, strings: TemplateStringsArray): unknown {
	const normalized = normalizeObservableHtmlResult(value, strings);
	installFormNamedProperties(normalized);
	return normalized;
}

function normalizeObservableHtmlResult(value: unknown, strings: TemplateStringsArray): unknown {
	if (!hasBoundaryWhitespace(strings)) return value;
	const element = singleElementChild(value);
	if (!element) return value;
	if (value instanceof DocumentFragment) return element;
	if (value instanceof HTMLElement && value.localName === "span" && value.attributes.length === 0) return element;
	return value;
}

function hasBoundaryWhitespace(strings: TemplateStringsArray): boolean {
	const first = strings[0] ?? "";
	const last = strings[strings.length - 1] ?? "";
	return first !== first.trimStart() || last !== last.trimEnd();
}

function singleElementChild(value: unknown): Element | null {
	if (!(value instanceof DocumentFragment || value instanceof HTMLElement)) return null;
	let element: Element | null = null;
	for (const child of value.childNodes) {
		if (child.nodeType === Node.ELEMENT_NODE) {
			if (element) return null;
			element = child as Element;
		} else if (child.nodeType === Node.TEXT_NODE) {
			if (/\S/.test(child.textContent ?? "")) return null;
		} else {
			return null;
		}
	}
	return element;
}

function coerceObservableHtmlValue(value: unknown): unknown {
	if (typeof value === "string") return htmlStringToFragment(value) ?? value;
	if (Array.isArray(value)) return value.map(coerceObservableHtmlValue);
	return value;
}

function htmlStringToFragment(value: string): DocumentFragment | null {
	if (!/<\/?[A-Za-z][^>]*>/.test(value)) return null;
	const template = document.createElement("template");
	template.innerHTML = value;
	return template.content;
}

function installFormNamedProperties(value: unknown): void {
	if (!(value instanceof Element || value instanceof DocumentFragment)) return;
	const forms = value instanceof HTMLFormElement ? [value] : Array.from(value.querySelectorAll("form"));
	for (const form of forms) installFormNamedPropertiesFor(form);
}

function installFormNamedPropertiesFor(form: HTMLFormElement): void {
	for (const element of Array.from(form.elements)) {
		const name = element.getAttribute("name");
		if (!name || name in form) continue;
		Object.defineProperty(form, name, {
			configurable: true,
			get: () => form.elements.namedItem(name),
		});
	}
}

function ObservableMutable(this: unknown, value: unknown): object {
	let change: ((value: unknown) => unknown) | undefined;
	const generator = observe((notify) => {
		change = notify;
		if (value !== undefined) notify(value);
	});
	return Object.defineProperties(
		{},
		{
			generator: { value: generator },
			value: {
				get: () => value,
				set: (next) => {
					value = next;
					change?.(value);
				},
			},
		},
	);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function registeredBlobUrl(
	file: ReturnType<typeof FileAttachment>,
	registry: AttachmentRegistry,
): Promise<string> {
	const cacheKey = attachmentCacheKey(file);
	const cached = registry.blobUrls.get(cacheKey);
	if (cached) return cached;
	if (typeof URL.createObjectURL !== "function") return file.url();
	const blob = await file.blob();
	if (registry.disposed) return file.url();
	const url = URL.createObjectURL(blob);
	if (registry.disposed) {
		URL.revokeObjectURL(url);
		return file.url();
	}
	registry.blobUrls.set(cacheKey, url);
	return url;
}

function attachmentCacheKey(file: ReturnType<typeof FileAttachment>): string {
	const href = "href" in file && typeof file.href === "string" ? file.href : "";
	return `${file.name}\n${href}`;
}

function attachmentTableName(name: string): string {
	return name.split(".").slice(0, -1).join(".").replace(/@.+?$/, "") || name;
}

function safeDecodeURI(value: string): string | null {
	try {
		return decodeURI(value);
	} catch {
		return null;
	}
}

export function registerAttachments(attachments: Record<string, AttachmentInfo>): AttachmentRegistry {
	// registerFile mutates Notebook Kit's global registry. Cleanup removes this base.
	const base = createAttachmentRegistryBase();
	const registered: string[] = [];
	const blobUrls = new Map<string, string>();
	for (const [name, info] of Object.entries(attachments)) {
		registerFile(
			name,
			{
				path: info.url,
				mimeType: info.mimeType,
				lastModified: info.lastModified,
				size: info.size,
			},
			base,
		);
		registered.push(name);
	}
	return {
		baseUrl: base,
		names: new Set(registered),
		blobUrls,
		disposed: false,
		cleanup() {
			if (this.disposed) return;
			this.disposed = true;
			for (const url of blobUrls.values()) URL.revokeObjectURL(url);
			blobUrls.clear();
			for (const name of registered) registerFile(name, null, base);
		},
	};
}

function createAttachmentRegistryBase(): string {
	const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Math.random().toString(36).slice(2);
	return new URL(`.pyobservablejs/${id}/`, document.baseURI).href;
}

type RuntimeDefinition = Parameters<NotebookRuntime["define"]>[1];
type RuntimeBody = RuntimeDefinition["body"];
type TranspiledDefinition = RuntimeCellDefinition;

const TEMPLATE_MODES = new Set<Cell["mode"]>(["dot", "html", "md", "sql", "tex"]);

export function createRuntimeDefinition(
	cell: Cell,
	definition: TranspiledDefinition,
	options: RuntimeDefinitionOptions = {},
): RuntimeDefinition {
	const { notebookNames, ...globals } = options;
	const body = compileRuntimeBody(definition.body, globals);
	return {
		id: cell.id,
		body: TEMPLATE_MODES.has(cell.mode) ? awaitTemplateInputs(body) : body,
		inputs: definition.inputs,
		outputs: definition.outputs,
		output: definition.output,
		autodisplay: definition.autodisplay,
		autoview: definition.autoview,
		automutable: definition.automutable,
		display: usesNotebookDisplayName(definition, notebookNames) ? false : (definition as RuntimeDefinition).display,
	};
}

function usesNotebookDisplayName(
	definition: TranspiledDefinition,
	notebookNames: ReadonlySet<string> | undefined,
): boolean {
	if (!notebookNames) return false;
	return (definition.inputs ?? []).some((name) => (name === "display" || name === "view") && notebookNames.has(name));
}

function compileRuntimeBody(source: TranspiledDefinition["body"], globals: RuntimeGlobals): RuntimeBody {
	if (typeof source === "function") return source as RuntimeBody;
	const entries = Object.entries(globals).filter((entry) => entry[1] !== undefined) as [string, unknown][];
	const names = entries.map(([name]) => name);
	const values = entries.map(([, value]) => value);
	return new Function(...names, `"use strict"; return (${source});`)(...values) as RuntimeBody;
}

function awaitTemplateInputs(body: RuntimeBody): RuntimeBody {
	return async function (this: unknown, ...values: unknown[]) {
		return body.call(this, ...(await Promise.all(values)));
	} as RuntimeBody;
}

export function runtimeDefinitionNames(definition: RuntimeDefinition): string[] {
	const names = new Set<string>();
	if (definition.output) {
		names.add(definition.output);
		if (definition.autoview) names.add(unprefix(definition.output, "viewof$"));
		if (definition.automutable) {
			const name = unprefix(definition.output, "mutable ");
			names.add(name);
			names.add(`mutable$${name}`);
		}
	} else {
		for (const name of definition.outputs ?? []) names.add(name);
	}
	return Array.from(names);
}

export function runtimeVariableNames(definition: TranspiledDefinition): string[] {
	const names = new Set(exposedVariableNames(definition));
	if (definition.output) {
		names.add(definition.output);
		if (definition.automutable) names.add(`mutable$${unprefix(definition.output, "mutable ")}`);
	} else {
		for (const name of definition.outputs ?? []) names.add(name);
	}
	return Array.from(names);
}
