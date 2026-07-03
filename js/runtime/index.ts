import type { Cell } from "@observablehq/notebook-kit";
import { FileAttachment, NotebookRuntime, library, registerFile } from "@observablehq/notebook-kit/runtime";
import { exposedVariableNames, unprefix, type RuntimeCellDefinition } from "./graph";
import { observe } from "./observe";
import { bindRuntimeScope, cleanupRuntimeScope, createRuntimeScope } from "./scope";
import { createVariableBuiltins } from "./values";
import {
	createRuntimeCompatibilityBuiltins,
	runtimeCompatibilityBuiltinNames,
	runtimeDefinitionCompatibility,
	type RuntimeCompatibilityOptions,
} from "./compat";

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
	runtimeCompatibility?: RuntimeCompatibilityOptions;
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
	createGenerators,
	createObservableHtml,
	createRuntimeCompatibilityBuiltins,
	runtimeCompatibilityBuiltinNames,
} from "./compat";
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
	runtimeCompatibility?: RuntimeCompatibilityOptions;
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

const CORE_RUNTIME_NAMES = new Set([
	...Object.keys(library),
	"DuckDBClient",
	"FileAttachment",
	"SQLite",
	"SQLiteDatabaseClient",
	"document",
	"width",
]);
let sqliteModule: Promise<SqlJsModule> | undefined;

export function createRuntime(
	root: HTMLElement,
	el: HTMLElement,
	options: NotebookOptions,
	attachmentRegistry: AttachmentRegistry,
): NotebookRuntime {
	// Python variables enter OJS as Observable builtins before Notebook Kit defines cells.
	const collisions = runtimeBuiltinCollisions(options.variables, options.runtimeCompatibility);
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
		SQLite: () => loadSQLiteModule(),
		SQLiteDatabaseClient: () => SQLiteDatabaseClient,
		document: () => scope.document,
		width: width as RuntimeBuiltins["width"],
		...createRuntimeCompatibilityBuiltins(options.runtimeCompatibility),
		...createVariableBuiltins(options.variables),
	} as RuntimeBuiltinsWithVars;
	const runtime = new NotebookRuntime(builtins);
	extendRuntimeFileAttachments(runtime);
	bindRuntimeScope(runtime, scope);
	return runtime;
}

function runtimeBuiltinCollisions(
	variables: Record<string, unknown>,
	compatibility: RuntimeCompatibilityOptions = {},
): string[] {
	const reserved = new Set([...CORE_RUNTIME_NAMES, ...runtimeCompatibilityBuiltinNames(compatibility)]);
	return Object.keys(variables)
		.filter((name) => reserved.has(name))
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

function currentWidth(root: HTMLElement, fallback: HTMLElement): number {
	return root.getBoundingClientRect().width || fallback.clientWidth || 928;
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
	const { notebookNames, runtimeCompatibility, ...globals } = options;
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
		display: (definition as RuntimeDefinition).display,
		...runtimeDefinitionCompatibility(definition, notebookNames, runtimeCompatibility),
	};
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
