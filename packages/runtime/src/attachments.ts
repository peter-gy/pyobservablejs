import { FileAttachment, type NotebookRuntime, registerFile } from "@observablehq/notebook-kit/runtime";
import type { RuntimeValue } from "@observablehq/runtime";
import { isCallable, isObjectValue, isString } from "./value-kind";

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
export type SQLiteValue = null | boolean | number | string | Uint8Array;
export type SQLiteRow = Record<string, SQLiteValue>;
export type SQLiteRows = SQLiteRow[] & { columns?: string[]; value?: SQLiteRows };
export type SQLiteSource = string | ArrayBuffer | Uint8Array | { arrayBuffer(): Promise<ArrayBuffer> };
type SqlJsDatabase = {
	exec(query: string, params?: SQLiteValue[]): SqlJsResult[];
};
type SqlJsResult = {
	columns: string[];
	values: SQLiteValue[][];
};
type SqlJsModule = {
	Database: new (data?: Uint8Array) => SqlJsDatabase;
};
type SqlJsInit = (options: { locateFile(name: string): string }) => Promise<SqlJsModule>;
type SQLiteGlobalConfig = {
	initSqlJs?: SqlJsInit;
	locateFile?(name: string): string;
};

type RuntimeRecord = Record<string, RuntimeValue>;
type DuckDBMethod<Receiver extends object> = (this: Receiver, ...args: RuntimeValue[]) => RuntimeValue;
type DuckDBFileAttachment = {
	name: string;
	href?: string;
	url(): Promise<string>;
	blob(): Promise<Blob>;
};

declare global {
	var initSqlJs: SqlJsInit | undefined;
	var observablejsSqlite: SQLiteGlobalConfig | undefined;
}

let sqliteModule: Promise<SqlJsModule> | undefined;

export function extendRuntimeFileAttachments(runtime: NotebookRuntime): void {
	const fileAttachments = runtime.runtime.fileAttachments;
	runtime.runtime.fileAttachments = (resolve: RuntimeFileResolver) => {
		const FileAttachment = fileAttachments(resolve);
		const wrapped = (name: string) => withSQLiteFileAttachment(FileAttachment(name));
		return Object.assign(wrapped, { prototype: FileAttachment.prototype });
	};
}

export function createFileAttachment(baseUrl: string, registry: AttachmentRegistry): RuntimeFileAttachmentFactory {
	// A synthetic base URL scopes registered attachments to this widget instance.
	const attachment = (name: string, base?: string) => {
		const key = String(name);
		if (base !== undefined) return withSQLiteFileAttachment(FileAttachment(key, base));
		const decoded = safeDecodeURI(key);
		const registered = registry.names.has(key) ? key : decoded && registry.names.has(decoded) ? decoded : null;
		return withSQLiteFileAttachment(
			FileAttachment(registered ?? key, registered ? registry.baseUrl : baseUrl || document.baseURI),
		);
	};
	return Object.assign(attachment, { prototype: FileAttachment.prototype });
}

function withSQLiteFileAttachment(file: ReturnType<typeof FileAttachment>): RuntimeFileAttachment {
	if (hasSQLiteFileAttachment(file)) return file;
	// SAFETY: The proxy preserves every FileAttachment member and adds the typed sqlite method.
	return new Proxy(file, {
		get(target, property) {
			if (property === "sqlite") return () => SQLiteDatabaseClient.open(target);
			if (!isKeyOf(target, property)) return undefined;
			return target[property];
		},
		has(target, property) {
			return property === "sqlite" || property in target;
		},
	}) as RuntimeFileAttachment;
}

function hasSQLiteFileAttachment(file: ReturnType<typeof FileAttachment>): file is RuntimeFileAttachment {
	return "sqlite" in file && isCallable(file.sqlite);
}

export class SQLiteDatabaseClient {
	constructor(private readonly db: SqlJsDatabase) {}

	static async open(source: SQLiteSource): Promise<SQLiteDatabaseClient> {
		const [sqlite, data] = await Promise.all([loadSQLiteModule(), loadSQLiteSource(source)]);
		return new SQLiteDatabaseClient(new sqlite.Database(data));
	}

	async query(query: string, params?: SQLiteValue[]): Promise<SQLiteRows> {
		return execSQLite(this.db, query, params);
	}

	async queryRow(query: string, params?: SQLiteValue[]): Promise<SQLiteRow | null> {
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
		const columns: SQLiteRows = rows.map(({ name, type, notnull }) => ({
			name,
			type: sqliteType(String(type)),
			databaseType: type,
			nullable: !notnull,
		}));
		return withSQLiteRowsValue(columns);
	}

	async describe(table?: string): Promise<SQLiteRows> {
		return table == null ? this.describeTables() : this.describeColumns({ table });
	}

	async sql(strings: TemplateStringsArray, ...params: SQLiteValue[]): Promise<SQLiteRows> {
		return this.query(...this.queryTag(strings, ...params));
	}

	queryTag(strings: TemplateStringsArray, ...params: SQLiteValue[]): [string, SQLiteValue[]] {
		return [strings.join("?"), params];
	}
}

Object.defineProperty(SQLiteDatabaseClient.prototype, "dialect", { value: "sqlite" });

export async function loadSQLiteModule(): Promise<SqlJsModule> {
	if (sqliteModule !== undefined) return sqliteModule;
	const config = globalThis.observablejsSqlite;
	const init = config?.initSqlJs ?? globalThis.initSqlJs;
	if (init === undefined) {
		throw new Error("SQLite requires a caller-provided sql.js initSqlJs loader");
	}
	const nextModule = init({
		locateFile: (name) => config?.locateFile?.(name) ?? name,
	});
	const guarded = nextModule.catch((cause) => {
		if (sqliteModule === guarded) sqliteModule = undefined;
		throw cause;
	});
	sqliteModule = guarded;
	return guarded;
}

async function loadSQLiteSource(source: SQLiteSource): Promise<Uint8Array> {
	if (isString(source)) return fetch(source).then(loadSQLiteSource);
	if (source instanceof ArrayBuffer) return new Uint8Array(source);
	if (source instanceof Uint8Array) return source;
	return source.arrayBuffer().then(loadSQLiteSource);
}

function execSQLite(db: SqlJsDatabase, query: string, params?: SQLiteValue[]): SQLiteRows {
	const [result] = db.exec(query, params);
	const rows: SQLiteRows = [];
	if (!result) return withSQLiteRowsValue(rows);
	for (const values of result.values) {
		const row: SQLiteRow = {};
		for (const [index, value] of values.entries()) {
			const column = result.columns[index];
			if (column !== undefined) row[column] = value;
		}
		rows.push(row);
	}
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
		get(target, property) {
			if (!isKeyOf(target, property)) return undefined;
			const value = target[property];
			if ((property === "of" || property === "sql") && isCallable(value)) {
				return (...args: RuntimeValue[]) => callDuckDBMethod(value, target, wrapDuckDBArgs(args, registry));
			}
			return value;
		},
	});
}

function callDuckDBMethod<Receiver extends object>(
	method: CallableFunction,
	receiver: Receiver,
	args: RuntimeValue[],
): RuntimeValue {
	// SAFETY: DuckDB static methods accept JavaScript runtime values and return a JavaScript runtime value.
	return (method as DuckDBMethod<Receiver>).apply(receiver, args);
}

function wrapDuckDBArgs(args: RuntimeValue[], registry: AttachmentRegistry): RuntimeValue[] {
	if (args.length === 0) return args;
	const [sources, ...rest] = args;
	if (isRuntimeArray(sources)) return [wrapDuckDBSourceEntries(sources, registry), ...rest];
	if (isFileAttachmentLike(sources)) {
		return [{ [attachmentTableName(sources.name)]: withDuckDBAttachmentUrl(sources, registry) }, ...rest];
	}
	return [wrapDuckDBSources(sources, registry), ...rest];
}

function wrapDuckDBSources(sources: RuntimeValue, registry: AttachmentRegistry): RuntimeValue {
	if (!isRuntimeRecord(sources)) return sources;
	return Object.fromEntries(
		Object.entries(sources).map(([name, source]) => [name, wrapDuckDBSource(source, registry)]),
	);
}

function wrapDuckDBSourceEntries(sources: RuntimeValue[], registry: AttachmentRegistry): RuntimeRecord {
	const entries = sources.map((source) => duckDBSourceEntry(source, registry));
	return Object.fromEntries(entries.filter((entry) => entry !== undefined));
}

function duckDBSourceEntry(source: RuntimeValue, registry: AttachmentRegistry): [string, RuntimeValue] | undefined {
	if (isRuntimeArray(source) && isString(source[0]) && source.length >= 2) {
		return [source[0], wrapDuckDBSource(source[1], registry)];
	}
	if (isFileAttachmentLike(source)) {
		return [attachmentTableName(source.name), withDuckDBAttachmentUrl(source, registry)];
	}
	if (isRuntimeRecord(source) && isFileAttachmentLike(source.file)) {
		const name = isString(source.name) && source.name ? source.name : attachmentTableName(source.file.name);
		return [name, wrapDuckDBSource(source, registry)];
	}
	return undefined;
}

function wrapDuckDBSource(source: RuntimeValue, registry: AttachmentRegistry): RuntimeValue {
	if (isFileAttachmentLike(source)) return withDuckDBAttachmentUrl(source, registry);
	if (isRuntimeRecord(source) && isFileAttachmentLike(source.file)) {
		return { ...source, file: withDuckDBAttachmentUrl(source.file, registry) };
	}
	return source;
}

function withDuckDBAttachmentUrl<File extends DuckDBFileAttachment>(file: File, registry: AttachmentRegistry): File {
	return new Proxy(file, {
		get(target, property) {
			if (property === "url") return () => registeredBlobUrl(target, registry);
			if (!isKeyOf(target, property)) return undefined;
			return target[property];
		},
	});
}

function isFileAttachmentLike(value: RuntimeValue): value is DuckDBFileAttachment {
	if (!isRuntimeRecord(value)) return false;
	return isString(value.name) && isCallable(value.url) && isCallable(value.blob);
}

function isRuntimeRecord(value: RuntimeValue): value is RuntimeRecord {
	return isObjectValue(value) && !isCallable(value) && !isRuntimeArray(value);
}

function isRuntimeArray(value: RuntimeValue): value is RuntimeValue[] {
	return Array.isArray(value);
}

async function registeredBlobUrl(file: DuckDBFileAttachment, registry: AttachmentRegistry): Promise<string> {
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
	file: DuckDBFileAttachment,
	registry: AttachmentRegistry,
	cacheKey: string,
): Promise<string> {
	if (!isCallable(URL.createObjectURL)) return file.url();
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

function attachmentCacheKey(file: DuckDBFileAttachment): string {
	return `${file.name}\n${file.href ?? ""}`;
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
	const id = isCallable(crypto.randomUUID) ? crypto.randomUUID() : Math.random().toString(36).slice(2);
	return new URL(`.pyobservablejs/${id}/`, document.baseURI).href;
}

function isKeyOf<Target extends object>(target: Target, property: PropertyKey): property is keyof Target {
	return property in target;
}
