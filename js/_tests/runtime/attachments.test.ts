// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import {
	createDuckDBClient,
	createFileAttachment,
	registerAttachments,
	SQLiteDatabaseClient,
} from "@/runtime/attachments";
import { createRuntime, createRuntimeCleanup, type NotebookOptions } from "@/runtime/environment";

const baseOptions: NotebookOptions = {
	attachments: {},
	baseUrl: "",
	variables: {},
	showSource: false,
};

afterEach(() => {
	vi.unstubAllGlobals();
});

test("shares concurrent DuckDB blob URL creation", async () => {
	const createObjectURL = vi.fn().mockReturnValueOnce("blob:first").mockReturnValueOnce("blob:second");
	const revokeObjectURL = vi.fn();
	const originalCreateObjectURL = URL.createObjectURL;
	const originalRevokeObjectURL = URL.revokeObjectURL;
	Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
	Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
	const registry = registerAttachments({});
	let resolveBlob: (blob: Blob) => void = () => {};
	const file = {
		name: "data.csv",
		href: "https://static.example/data.csv",
		url: vi.fn(async () => "https://static.example/data.csv"),
		blob: vi.fn(() => new Promise<Blob>((resolve) => (resolveBlob = resolve))),
	};
	const DuckDBClient = {
		of: vi.fn((sources: Record<string, unknown>) => sources),
	};

	try {
		const sources = createDuckDBClient(DuckDBClient, registry).of({ data: file }) as Record<string, typeof file>;
		const first = sources.data.url();
		const second = sources.data.url();
		expect(file.blob).toHaveBeenCalledOnce();

		resolveBlob(new Blob(["x"], { type: "text/csv" }));
		await expect(Promise.all([first, second])).resolves.toEqual(["blob:first", "blob:first"]);
		expect(createObjectURL).toHaveBeenCalledOnce();
	} finally {
		registry.cleanup();
		Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreateObjectURL });
		Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originalRevokeObjectURL });
	}

	expect(revokeObjectURL).toHaveBeenCalledWith("blob:first");
});

describe("runtime attachments", () => {
	test("resolves percent-encoded FileAttachment names to registered raw names", async () => {
		const registry = registerAttachments({
			"100% complete.csv": {
				url: "data:text/csv;base64,eA==",
				mimeType: "text/csv",
			},
		});
		const FileAttachment = createFileAttachment("", registry);

		try {
			await expect(FileAttachment("100%25 complete.csv").url()).resolves.toBe("data:text/csv;base64,eA==");
		} finally {
			registry.cleanup();
		}
	});

	test("falls back to the notebook base for unregistered malformed percent names", async () => {
		const registry = registerAttachments({});
		const FileAttachment = createFileAttachment("https://example.test/notebook/", registry);

		try {
			const url = await FileAttachment("missing 100% complete.csv").url();
			const parsed = new URL(url);
			expect(parsed.origin).toBe("https://example.test");
			expect(parsed.pathname).toContain("/notebook/");
			expect(parsed.pathname).toContain("missing");
			expect(parsed.pathname).toContain("complete.csv");
		} finally {
			registry.cleanup();
		}
	});

	test("keeps registered attachment URLs stable outside DuckDB", async () => {
		const registry = registerAttachments({
			"data.csv": {
				url: "data:text/csv;base64,eA==",
				mimeType: "text/csv",
			},
		});
		const FileAttachment = createFileAttachment("", registry);

		try {
			await expect(FileAttachment("data.csv").url()).resolves.toBe("data:text/csv;base64,eA==");
		} finally {
			registry.cleanup();
		}
	});

	test("exposes SQLite database loading on FileAttachment", async () => {
		const registry = registerAttachments({
			"chinook.db": {
				url: "data:application/octet-stream;base64,eA==",
				mimeType: "application/octet-stream",
			},
		});
		const FileAttachment = createFileAttachment("", registry);
		const client = { dialect: "sqlite" };
		const open = vi.spyOn(SQLiteDatabaseClient, "open").mockResolvedValue(client as unknown as SQLiteDatabaseClient);

		try {
			const file = FileAttachment("chinook.db");
			await expect(file.sqlite()).resolves.toBe(client);
			expect(open).toHaveBeenCalledWith(expect.objectContaining({ name: "chinook.db" }));
		} finally {
			open.mockRestore();
			registry.cleanup();
		}
	});

	test("exposes SQLite loading on imported Observable file attachments", async () => {
		const registry = registerAttachments({});
		const root = document.createElement("div");
		const el = document.createElement("div");
		root.append(el);
		const runtime = createRuntime(root, el, baseOptions, registry);
		const client = { dialect: "sqlite" };
		const open = vi.spyOn(SQLiteDatabaseClient, "open").mockResolvedValue(client as unknown as SQLiteDatabaseClient);

		try {
			const importedFileAttachment = runtime.runtime.fileAttachments((name: string) =>
				name === "chinook.db" ? { url: "data:application/octet-stream;base64,eA==" } : null,
			);
			const file = importedFileAttachment("chinook.db") as ReturnType<typeof importedFileAttachment> & {
				sqlite(): Promise<SQLiteDatabaseClient>;
			};

			await expect(file.sqlite()).resolves.toBe(client);
			expect(open).toHaveBeenCalledWith(expect.objectContaining({ name: "chinook.db" }));
		} finally {
			open.mockRestore();
			createRuntimeCleanup(runtime, registry)();
		}
	});

	test("evicts failed SQLite loads so later runtimes can retry", async () => {
		const registry = registerAttachments({});
		const root = document.createElement("div");
		const el = document.createElement("div");
		root.append(el);
		const missingLoaderRuntime = createRuntime(root, document.createElement("div"), baseOptions, registry);
		missingLoaderRuntime.main.define("missingSQLiteProbe", ["SQLite"], (SQLite: unknown) => SQLite);
		await expect(missingLoaderRuntime.main.value("missingSQLiteProbe")).rejects.toThrow(
			"SQLite requires a caller-provided sql.js initSqlJs loader",
		);
		createRuntimeCleanup(missingLoaderRuntime, registry)();

		const initSqlJs = vi
			.fn()
			.mockRejectedValueOnce(new Error("loader unavailable"))
			.mockResolvedValue({
				Database: class TestDatabase {
					exec(): [] {
						return [];
					}
				},
			});
		vi.stubGlobal("observablejsSqlite", {
			initSqlJs,
			locateFile: (name: string) => `/sql/${name}`,
		});
		const runtime = createRuntime(root, el, baseOptions, registry);
		const retryRuntime = createRuntime(root, document.createElement("div"), baseOptions, registry);

		try {
			runtime.main.define("failedSQLiteProbe", ["SQLite"], (SQLite: unknown) => SQLite);
			await expect(runtime.main.value("failedSQLiteProbe")).rejects.toThrow("loader unavailable");

			runtime.main.define(
				"sqliteDatabaseClientProbe",
				["SQLiteDatabaseClient"],
				(SQLiteDatabaseClient: unknown) => SQLiteDatabaseClient,
			);
			retryRuntime.main.define("sqliteProbe", ["SQLite"], (SQLite: unknown) => SQLite);
			await expect(runtime.main.value("sqliteDatabaseClientProbe")).resolves.toBe(SQLiteDatabaseClient);
			await expect(retryRuntime.main.value("sqliteProbe")).resolves.toMatchObject({ Database: expect.any(Function) });
			expect(initSqlJs).toHaveBeenCalledTimes(2);
			const locateFile = initSqlJs.mock.calls[1]?.[0].locateFile;
			expect(locateFile("sql-wasm.wasm")).toBe("/sql/sql-wasm.wasm");
		} finally {
			createRuntimeCleanup(runtime, registry)();
			createRuntimeCleanup(retryRuntime, registry)();
		}
	});
	test("describes SQLite tables and columns through the compatibility API", async () => {
		const db = {
			exec: vi.fn((query: string) =>
				query.includes("pragma_table_list")
					? [{ columns: ["schema", "name"], values: [[null, "tracks"]] }]
					: [{ columns: ["name", "type", "notnull"], values: [["TrackId", "INTEGER", 1]] }],
			),
		} as ConstructorParameters<typeof SQLiteDatabaseClient>[0];
		const client = new SQLiteDatabaseClient(db);

		const tables = await client.describe();
		const columns = await client.describe("tracks");
		expect(Array.from(tables)).toEqual([{ schema: null, name: "tracks" }]);
		expect(tables.value).toBe(tables);
		expect(Array.from(columns)).toEqual([
			{
				name: "TrackId",
				type: "integer",
				databaseType: "INTEGER",
				nullable: false,
			},
		]);
		expect(columns.value).toBe(columns);
	});

	test("serves registered DuckDB attachments through revocable blob URLs", async () => {
		const createObjectURL = vi.fn(() => "blob:registered-data");
		const revokeObjectURL = vi.fn();
		const originalCreateObjectURL = URL.createObjectURL;
		const originalRevokeObjectURL = URL.revokeObjectURL;
		Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
		Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
		const registry = registerAttachments({
			"data.csv": {
				url: "data:text/csv;base64,eA==",
				mimeType: "text/csv",
			},
		});
		const FileAttachment = createFileAttachment("", registry);
		const DuckDBClient = {
			of: vi.fn((sources: Record<string, unknown>) => sources),
		};
		const wrappedDuckDBClient = createDuckDBClient(DuckDBClient, registry);

		try {
			const file = FileAttachment("data.csv");
			const sources = wrappedDuckDBClient.of({ data: file }) as Record<string, typeof file>;
			await expect(sources.data.url()).resolves.toBe("blob:registered-data");
			await expect(sources.data.url()).resolves.toBe("blob:registered-data");
			expect(createObjectURL).toHaveBeenCalledOnce();
		} finally {
			registry.cleanup();
			Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreateObjectURL });
			Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originalRevokeObjectURL });
		}
		expect(revokeObjectURL).toHaveBeenCalledWith("blob:registered-data");
	});

	test("serves imported DuckDB attachments through revocable blob URLs", async () => {
		const createObjectURL = vi.fn(() => "blob:imported-data");
		const revokeObjectURL = vi.fn();
		const originalCreateObjectURL = URL.createObjectURL;
		const originalRevokeObjectURL = URL.revokeObjectURL;
		Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
		Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
		const registry = registerAttachments({});
		const file = {
			name: "stores@1.csv",
			href: "https://static.example/stores.csv",
			url: vi.fn(async () => "https://static.example/stores.csv"),
			blob: vi.fn(async () => new Blob(["x"], { type: "text/csv" })),
		};
		const DuckDBClient = {
			of: vi.fn((sources: Record<string, unknown>) => sources),
		};
		const wrappedDuckDBClient = createDuckDBClient(DuckDBClient, registry);

		try {
			const sources = wrappedDuckDBClient.of({ stores: file }) as Record<string, typeof file>;
			await expect(sources.stores.url()).resolves.toBe("blob:imported-data");
			expect(file.blob).toHaveBeenCalledOnce();
			expect(file.url).not.toHaveBeenCalled();
		} finally {
			registry.cleanup();
			Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreateObjectURL });
			Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originalRevokeObjectURL });
		}
		expect(revokeObjectURL).toHaveBeenCalledWith("blob:imported-data");
	});

	test("does not create DuckDB blob URLs after attachment cleanup", async () => {
		const createObjectURL = vi.fn(() => "blob:late-data");
		const revokeObjectURL = vi.fn();
		const originalCreateObjectURL = URL.createObjectURL;
		const originalRevokeObjectURL = URL.revokeObjectURL;
		Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
		Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
		const registry = registerAttachments({});
		let resolveBlob: (value: Blob) => void = () => {};
		const file = {
			name: "stores@1.csv",
			href: "https://static.example/stores.csv",
			url: vi.fn(async () => "https://static.example/stores.csv"),
			blob: vi.fn(() => new Promise<Blob>((resolve) => (resolveBlob = resolve))),
		};
		const DuckDBClient = {
			of: vi.fn((sources: Record<string, unknown>) => sources),
		};
		const wrappedDuckDBClient = createDuckDBClient(DuckDBClient, registry);

		try {
			const sources = wrappedDuckDBClient.of({ stores: file }) as Record<string, typeof file>;
			const url = sources.stores.url();
			registry.cleanup();
			resolveBlob(new Blob(["x"], { type: "text/csv" }));

			await expect(url).resolves.toBe("https://static.example/stores.csv");
			expect(createObjectURL).not.toHaveBeenCalled();
			expect(revokeObjectURL).not.toHaveBeenCalled();
			expect(registry.blobUrls.size).toBe(0);
		} finally {
			registry.cleanup();
			Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreateObjectURL });
			Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originalRevokeObjectURL });
		}
	});

	test("falls back when cleanup runs during DuckDB blob URL creation", async () => {
		const revokeObjectURL = vi.fn();
		const originalCreateObjectURL = URL.createObjectURL;
		const originalRevokeObjectURL = URL.revokeObjectURL;
		const registry = registerAttachments({});
		const createObjectURL = vi.fn(() => {
			registry.cleanup();
			return "blob:disposed-data";
		});
		Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
		Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
		const file = {
			name: "stores@1.csv",
			href: "https://static.example/stores.csv",
			url: vi.fn(async () => "https://static.example/stores.csv"),
			blob: vi.fn(async () => new Blob(["x"], { type: "text/csv" })),
		};
		const DuckDBClient = {
			of: vi.fn((sources: Record<string, unknown>) => sources),
		};
		const wrappedDuckDBClient = createDuckDBClient(DuckDBClient, registry);

		try {
			const sources = wrappedDuckDBClient.of({ stores: file }) as Record<string, typeof file>;

			await expect(sources.stores.url()).resolves.toBe("https://static.example/stores.csv");
			expect(revokeObjectURL).toHaveBeenCalledWith("blob:disposed-data");
			expect(registry.blobUrls.size).toBe(0);
		} finally {
			registry.cleanup();
			Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreateObjectURL });
			Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originalRevokeObjectURL });
		}
	});

	test("normalizes legacy DuckDBClient array sources", async () => {
		const createObjectURL = vi.fn(() => "blob:imported-data");
		const originalCreateObjectURL = URL.createObjectURL;
		Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
		const registry = registerAttachments({});
		const file = {
			name: "papers@1.csv",
			href: "https://static.example/papers.csv",
			url: vi.fn(async () => "https://static.example/papers.csv"),
			blob: vi.fn(async () => new Blob(["x"], { type: "text/csv" })),
		};
		const DuckDBClient = {
			of: vi.fn((sources: unknown) => sources),
		};
		const wrappedDuckDBClient = createDuckDBClient(DuckDBClient, registry);

		try {
			const sources = wrappedDuckDBClient.of([["named", file], file, { name: "custom", file }]) as Record<
				string,
				typeof file | { file: typeof file }
			>;

			await expect((sources.named as typeof file).url()).resolves.toBe("blob:imported-data");
			await expect((sources.papers as typeof file).url()).resolves.toBe("blob:imported-data");
			await expect((sources.custom as { file: typeof file }).file.url()).resolves.toBe("blob:imported-data");
		} finally {
			registry.cleanup();
			Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreateObjectURL });
		}
	});
});
