import { FileAttachment, type NotebookRuntime, registerFile } from "@observablehq/notebook-kit/runtime";

export type AttachmentInfo = {
	url: string;
	mimeType?: string;
	lastModified?: number;
	size?: number;
};

export type AttachmentRegistry = {
	baseUrl: string;
	names: Set<string>;
	blobUrls: Map<string, string>;
	disposed: boolean;
	cleanup(): void;
};

const blobUrlPromises = new WeakMap<AttachmentRegistry, Map<string, Promise<string>>>();

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

let sqliteModule: Promise<SqlJsModule> | undefined;

export function extendRuntimeFileAttachments(runtime: NotebookRuntime): void {
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

export async function loadSQLiteModule(): Promise<SqlJsModule> {
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
	if (registry.disposed) return file.url();
	const cached = registry.blobUrls.get(cacheKey);
	if (cached) return cached;
	const promises = blobUrlPromiseMap(registry);
	const pending = promises.get(cacheKey);
	if (pending) return pending;
	const next = createRegisteredBlobUrl(file, registry, cacheKey);
	promises.set(cacheKey, next);
	try {
		return await next;
	} finally {
		if (promises.get(cacheKey) === next) promises.delete(cacheKey);
	}
}

function blobUrlPromiseMap(registry: AttachmentRegistry): Map<string, Promise<string>> {
	const existing = blobUrlPromises.get(registry);
	if (existing) return existing;
	const promises = new Map<string, Promise<string>>();
	blobUrlPromises.set(registry, promises);
	return promises;
}

async function createRegisteredBlobUrl(
	file: ReturnType<typeof FileAttachment>,
	registry: AttachmentRegistry,
	cacheKey: string,
): Promise<string> {
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
			blobUrlPromises.delete(this);
			for (const name of registered) registerFile(name, null, base);
		},
	};
}

function createAttachmentRegistryBase(): string {
	const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Math.random().toString(36).slice(2);
	return new URL(`.pyobservablejs/${id}/`, document.baseURI).href;
}
