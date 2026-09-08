declare module "@observablehq/stdlib" {
	type SQLiteValue = null | boolean | number | string | Uint8Array;
	type SQLiteRows = Record<string, SQLiteValue>[] & { columns?: string[] };
	type SQLiteSource = string | ArrayBuffer | Uint8Array | { arrayBuffer(): Promise<ArrayBuffer> };
	interface SQLiteDatabase {
		exec(query: string, params?: SQLiteValue[]): { columns: string[]; values: SQLiteValue[][] }[];
	}
	interface SQLiteClient {
		readonly dialect: "sqlite";
		query(query: string, params?: SQLiteValue[]): Promise<SQLiteRows>;
		queryRow(query: string, params?: SQLiteValue[]): Promise<SQLiteRows[number] | null>;
		sql(strings: readonly string[], ...params: SQLiteValue[]): Promise<SQLiteRows>;
		queryTag(strings: readonly string[], ...params: SQLiteValue[]): [string, SQLiteValue[]];
		describeTables(options?: { schema?: string }): Promise<SQLiteRows>;
		describeColumns(options: { schema?: string; table: string }): Promise<SQLiteRows>;
		describe(table?: string): Promise<HTMLTableElement & { value: SQLiteRows }>;
		explain(query: string, params?: SQLiteValue[]): Promise<HTMLPreElement>;
	}
	interface SQLiteClientConstructor {
		new (database: SQLiteDatabase): SQLiteClient;
		open(source: SQLiteSource): Promise<SQLiteClient>;
	}
	export class Library {
		static require: (...specifiers: string[]) => Promise<import("@observablehq/runtime").RuntimeValue>;
		constructor(resolver?: (specifier: string, base?: string) => string | Promise<string>);
		SQLiteDatabaseClient(): SQLiteClientConstructor;
		[name: string]: import("@observablehq/runtime").RuntimeValue;
	}
}
