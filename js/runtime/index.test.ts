// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import type { Cell, transpile } from "@observablehq/notebook-kit";
import {
	createFileAttachment,
	createDuckDBClient,
	createRuntime,
	createRuntimeCleanup,
	createRuntimeDefinition,
	createGenerators,
	registerAttachments,
	runtimeDocument,
	SQLiteDatabaseClient,
	type AttachmentRegistry,
	type NotebookOptions,
} from "./index";
import { waitFor } from "../widget/testing";

const baseOptions: NotebookOptions = {
	attachments: {},
	baseUrl: "",
	variables: {},
	showSource: false,
};

describe("runtime bindings", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

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

	test("exposes SQLite globals through the Observable runtime", async () => {
		const registry = registerAttachments({});
		const root = document.createElement("div");
		const el = document.createElement("div");
		root.append(el);
		const initSqlJs = vi.fn(async () => ({
			Database: class TestDatabase {
				exec(): [] {
					return [];
				}
			},
		}));
		vi.stubGlobal("initSqlJs", initSqlJs);
		const append = vi.spyOn(document.head, "append").mockImplementation((...nodes: (Node | string)[]) => {
			for (const node of nodes) {
				if (node instanceof HTMLScriptElement) {
					queueMicrotask(() => node.onload?.(new Event("load")));
				}
			}
		});
		const runtime = createRuntime(root, el, baseOptions, registry);

		try {
			runtime.main.define(
				"sqliteDatabaseClientProbe",
				["SQLiteDatabaseClient"],
				(SQLiteDatabaseClient: unknown) => SQLiteDatabaseClient,
			);
			runtime.main.define("sqliteProbe", ["SQLite"], (SQLite: unknown) => SQLite);
			await expect(runtime.main.value("sqliteDatabaseClientProbe")).resolves.toBe(SQLiteDatabaseClient);
			await expect(runtime.main.value("sqliteProbe")).resolves.toMatchObject({ Database: expect.any(Function) });
			expect(initSqlJs).toHaveBeenCalledWith({ locateFile: expect.any(Function) });
			expect(append).toHaveBeenCalledWith(expect.objectContaining({ src: expect.stringContaining("sql-wasm.js") }));
		} finally {
			append.mockRestore();
			createRuntimeCleanup(runtime, registry)();
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

			expect(Object.keys(sources)).toEqual(["named", "papers", "custom"]);
			await expect((sources.named as typeof file).url()).resolves.toBe("blob:imported-data");
			await expect((sources.papers as typeof file).url()).resolves.toBe("blob:imported-data");
			await expect((sources.custom as { file: typeof file }).file.url()).resolves.toBe("blob:imported-data");
		} finally {
			registry.cleanup();
			Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreateObjectURL });
		}
	});

	test("keeps observe async while supporting old sync iteration consumers", async () => {
		const dispose = vi.fn();
		const Generators = createGenerators({
			observe(initialize: (change: (value: string) => void) => () => void): AsyncGenerator<string> {
				let value = "";
				const cleanup = initialize((next) => {
					value = next;
				});
				return {
					async next() {
						return { done: false, value };
					},
					async return() {
						cleanup();
						return { done: true, value: undefined };
					},
					async throw(error) {
						throw error;
					},
					[Symbol.asyncIterator]() {
						return this;
					},
				};
			},
		});

		const generator: AsyncGenerator<string> & Iterable<Promise<string | undefined>> = Generators.observe((change) => {
			change("ready");
			return dispose;
		}) as AsyncGenerator<string> & Iterable<Promise<string | undefined>>;
		await expect(generator.next()).resolves.toEqual({ done: false, value: "ready" });
		const iterator = generator[Symbol.iterator]();
		await expect(iterator.next().value).resolves.toBe("ready");
		iterator.return?.();

		expect(dispose).toHaveBeenCalledOnce();
	});

	test("updates the Observable width builtin when the root resizes", async () => {
		class TestResizeObserver {
			static instances: TestResizeObserver[] = [];
			observing = false;
			observe = vi.fn(() => {
				this.observing = true;
			});
			disconnect = vi.fn(() => {
				this.observing = false;
			});

			constructor(private readonly callback: ResizeObserverCallback) {
				TestResizeObserver.instances.push(this);
			}

			emit(width: number): void {
				if (!this.observing) return;
				this.callback(
					[
						{
							contentRect: { width } as DOMRectReadOnly,
						} as ResizeObserverEntry,
					],
					this as unknown as ResizeObserver,
				);
			}
		}
		vi.stubGlobal("ResizeObserver", TestResizeObserver);
		const root = document.createElement("div");
		const el = document.createElement("div");
		root.getBoundingClientRect = () => ({ width: 400 }) as DOMRect;
		const registry: AttachmentRegistry = {
			baseUrl: "",
			names: new Set(),
			blobUrls: new Map(),
			cleanup() {},
		};
		const runtime = createRuntime(root, el, baseOptions, registry);
		const values: number[] = [];

		runtime.main
			.variable({
				pending() {},
				fulfilled(value: unknown) {
					values.push(value as number);
				},
				rejected(error: unknown) {
					throw error;
				},
			})
			.define("observedWidth", ["width"], (width: number) => width);

		expect(await waitFor(() => (last(values) === 400 ? 400 : undefined))).toBe(400);
		const observer = TestResizeObserver.instances[0]!;
		observer.emit(640);
		expect(await waitFor(() => (last(values) === 640 ? 640 : undefined))).toBe(640);
		const cleanup = createRuntimeCleanup(runtime, registry);
		cleanup();
		await waitFor(() => (observer.observing ? undefined : true));
		expect(observer.observing).toBe(false);
		observer.emit(800);
		await new Promise((resolve) => window.setTimeout(resolve, 20));
		expect(values).toEqual([400, 640]);
	});

	test("scopes the document builtin to the notebook root", async () => {
		const root = document.createElement("div");
		root.className = "observablehq-root";
		const localHeading = document.createElement("h2");
		localHeading.id = 'local heading"]';
		localHeading.className = "slide";
		localHeading.textContent = "Inside";
		root.append(localHeading);
		const outside = document.createElement("section");
		outside.id = "outside-heading";
		outside.className = "outside-only slide";
		outside.innerHTML = "<h2>Outside</h2>";
		document.body.append(outside);
		const el = document.createElement("div");
		const registry: AttachmentRegistry = {
			baseUrl: "",
			names: new Set(),
			blobUrls: new Map(),
			cleanup() {},
		};
		const runtime = createRuntime(root, el, baseOptions, registry);
		const values: Array<{
			rootFound: boolean;
			headings: string[];
			localIdFound: boolean;
			slides: string[];
			customCurrent: number;
			outsideVisible: boolean;
			createdTag: string;
			baseURI: string;
		}> = [];

		runtime.main
			.variable({
				pending() {},
				fulfilled(value: unknown) {
					values.push(value as (typeof values)[number]);
				},
				rejected(error: unknown) {
					throw error;
				},
			})
			.define("documentProbe", ["document"], (document: Document) => {
				(document as Document & { current?: number }).current = 4;
				return {
					rootFound: document.querySelector(".observablehq-root") === root,
					headings: [...document.querySelectorAll("h2")].map((node) => node.textContent ?? ""),
					localIdFound: document.getElementById('local heading"]') === localHeading,
					slides: [...document.getElementsByClassName("slide")].map((node) => node.textContent ?? ""),
					customCurrent: (document as Document & { current?: number }).current ?? 0,
					outsideVisible:
						document.querySelector(".outside-only") !== null || document.getElementById("outside-heading") !== null,
					createdTag: document.createElement("span").tagName,
					baseURI: document.baseURI,
				};
			});

		expect(await waitFor(() => values[0])).toEqual({
			rootFound: true,
			headings: ["Inside"],
			localIdFound: true,
			slides: ["Inside"],
			customCurrent: 4,
			outsideVisible: false,
			createdTag: "SPAN",
			baseURI: document.baseURI,
		});

		const runtimeDefinition = createRuntimeDefinition(
			{ id: 1, mode: "ojs", value: "" } as Cell,
			{
				body: 'function(){ return document.querySelector(".observablehq-root")?.textContent; }',
				inputs: [],
				outputs: [],
				autodisplay: true,
				autoview: false,
				automutable: false,
			} as ReturnType<typeof transpile>,
			{ document: runtimeDocument(runtime) },
		);
		expect(runtimeDefinition.body()).toBe("Inside");
		createRuntimeCleanup(runtime, registry)();
		outside.remove();
	});

	test("keeps document selectors isolated across simultaneous runtimes", () => {
		const firstRoot = document.createElement("div");
		firstRoot.className = "observablehq-root";
		firstRoot.innerHTML = '<span id="shared-target" class="first-only">First</span>';
		const secondRoot = document.createElement("div");
		secondRoot.className = "observablehq-root";
		secondRoot.innerHTML = '<span id="shared-target" class="second-only">Second</span>';
		const registry: AttachmentRegistry = {
			baseUrl: "",
			names: new Set(),
			blobUrls: new Map(),
			cleanup() {},
		};
		const firstRuntime = createRuntime(firstRoot, document.createElement("div"), baseOptions, registry);
		const secondRuntime = createRuntime(secondRoot, document.createElement("div"), baseOptions, registry);

		try {
			const firstDocument = runtimeDocument(firstRuntime)!;
			const secondDocument = runtimeDocument(secondRuntime)!;

			expect(firstDocument.querySelector(".observablehq-root")).toBe(firstRoot);
			expect(secondDocument.querySelector(".observablehq-root")).toBe(secondRoot);
			expect(firstDocument.getElementById("shared-target")?.textContent).toBe("First");
			expect(secondDocument.getElementById("shared-target")?.textContent).toBe("Second");
			expect(firstDocument.querySelector(".second-only")).toBeNull();
			expect(secondDocument.querySelector(".first-only")).toBeNull();
		} finally {
			createRuntimeCleanup(firstRuntime, registry)();
			createRuntimeCleanup(secondRuntime, registry)();
		}
	});

	test("releases runtime scope on cleanup", () => {
		const registry: AttachmentRegistry = {
			baseUrl: "",
			names: new Set(),
			blobUrls: new Map(),
			cleanup() {},
		};
		const runtime = createRuntime(document.createElement("div"), document.createElement("div"), baseOptions, registry);

		expect(runtimeDocument(runtime)).toBeDefined();
		createRuntimeCleanup(runtime, registry)();

		expect(runtimeDocument(runtime)).toBeUndefined();
	});

	test("awaits template inputs without replacing the previous value receiver", async () => {
		const definition = createRuntimeDefinition(
			{ id: 1, mode: "md", value: "" } as Cell,
			{
				body: 'function(md, gain) { return {receiver: this, text: md([`${this ? "updated" : "initial"} ${gain}`])}; }',
				inputs: ["md", "gain"],
				outputs: [],
				autodisplay: true,
				autoview: false,
				automutable: false,
			} as ReturnType<typeof transpile>,
		);
		const renderMarkdown = (parts: readonly string[]) => parts[0];
		const previous = { rendered: true };

		await expect(definition.body.call(undefined, Promise.resolve(renderMarkdown), 1)).resolves.toEqual({
			receiver: undefined,
			text: "initial 1",
		});
		await expect(definition.body.call(previous, Promise.resolve(renderMarkdown), 2)).resolves.toEqual({
			receiver: previous,
			text: "updated 2",
		});
	});
});

function last<T>(values: T[]): T | undefined {
	return values[values.length - 1];
}
