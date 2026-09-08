import type { SqlJsInit, SQLiteGlobalConfig } from "../attachments";

declare global {
	var initSqlJs: SqlJsInit | undefined;
	var observablejsSqlite: SQLiteGlobalConfig | undefined;
}
