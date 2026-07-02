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
	createObservableHtml,
	registerAttachments,
	runtimeDocument,
	SQLiteDatabaseClient,
	type AttachmentRegistry,
	type NotebookOptions,
} from "@/runtime";
import { waitFor } from "@/_tests/testing";

const baseOptions: NotebookOptions = {
	attachments: {},
	baseUrl: "",
	variables: {},
	showSource: false,
};
type LegacyRequire = {
	(...specifiers: unknown[]): Promise<unknown>;
	resolve(specifier: unknown): string;
	alias(aliases: Record<string, string>): LegacyRequire;
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

	test("rejects Python variables that collide with runtime builtins", () => {
		const registry = registerAttachments({});
		const root = document.createElement("div");
		const el = document.createElement("div");

		try {
			expect(() =>
				createRuntime(
					root,
					el,
					{
						...baseOptions,
						variables: { FileAttachment: "shadowed", document: "shadowed", require: "shadowed" },
					},
					registry,
				),
			).toThrow("Python variables cannot override Observable runtime builtins: FileAttachment, document, require");
		} finally {
			registry.cleanup();
		}
	});

	test("exposes legacy Observable require in runtime builtins", async () => {
		const registry = registerAttachments({});
		const runtime = createRuntime(document.createElement("div"), document.createElement("div"), baseOptions, registry);
		const defaultModule = moduleUrl("export default {value: 42};");
		const namedModule = moduleUrl("export const value = 7;");

		try {
			runtime.main.define("defaultRequireProbe", ["require"], async (require: LegacyRequire) => {
				const module = (await require(defaultModule)) as { value: number };
				module.value += 1;
				return module;
			});
			runtime.main.define("cachedRequireProbe", ["require"], async (require: LegacyRequire) => require(defaultModule));
			runtime.main.define("mergedRequireProbe", ["require"], async (require: LegacyRequire) =>
				require(defaultModule, namedModule),
			);

			await expect(runtime.main.value("defaultRequireProbe")).resolves.toMatchObject({ value: 43 });
			await expect(runtime.main.value("cachedRequireProbe")).resolves.toMatchObject({ value: 43 });
			await expect(runtime.main.value("mergedRequireProbe")).resolves.toMatchObject({ value: 7 });
		} finally {
			createRuntimeCleanup(runtime, registry)();
		}
	});

	test("supports legacy Observable require.resolve and require.alias", async () => {
		const registry = registerAttachments({});
		const runtime = createRuntime(document.createElement("div"), document.createElement("div"), baseOptions, registry);
		const aliasedModule = moduleUrl("export default {label: 'aliased'};");

		try {
			runtime.main.define("requireApiProbe", ["require"], async (require: LegacyRequire) => {
				const alias = require.alias({ local: aliasedModule });
				return {
					d3: require.resolve("d3@7"),
					javascriptPath: require.resolve("geometric@2/src/line.js"),
					textPath: require.resolve("example-package/data.txt"),
					directoryPath: require.resolve("example-package/assets/"),
					scopedPath: require.resolve("@scope/package@1/path.js"),
					protocol: require.resolve("https://cdn.example/module.js"),
					local: require.resolve("./local.js"),
					aliased: await alias("local"),
				};
			});

			await expect(runtime.main.value("requireApiProbe")).resolves.toMatchObject({
				d3: "https://cdn.jsdelivr.net/npm/d3@7/+esm",
				javascriptPath: "https://cdn.jsdelivr.net/npm/geometric@2/src/line.js/+esm",
				textPath: "https://cdn.jsdelivr.net/npm/example-package/data.txt",
				directoryPath: "https://cdn.jsdelivr.net/npm/example-package/assets/",
				scopedPath: "https://cdn.jsdelivr.net/npm/@scope/package@1/path.js/+esm",
				protocol: "https://cdn.example/module.js",
				local: "./local.js",
				aliased: { label: "aliased" },
			});
		} finally {
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

	test("keeps input generators in the runtime native shape", async () => {
		const generator: AsyncGenerator<string> = {
			async next() {
				return { done: false, value: "ready" };
			},
			async return() {
				return { done: true, value: undefined };
			},
			async throw(error) {
				throw error;
			},
			[Symbol.asyncIterator]() {
				return this;
			},
		};
		const input = vi.fn((_view: string) => generator);
		const Generators = createGenerators({ input });

		const value = Generators.input("view");

		expect(value).toBe(generator);
		expect(Symbol.iterator in Object(value)).toBe(false);
		await expect(value.next()).resolves.toEqual({ done: false, value: "ready" });
	});

	test("exposes mutable holders to raw Observable runtime modules", async () => {
		const registry = registerAttachments({});
		const runtime = createRuntime(document.createElement("div"), document.createElement("div"), baseOptions, registry);

		try {
			runtime.main.define("initial x", [], () => 0);
			runtime.main
				.variable(true)
				.define("mutable x", ["Mutable", "initial x"], (Mutable: new (value: number) => object, x: number) => {
					return new Mutable(x);
				});
			runtime.main
				.variable(true)
				.define("x", ["mutable x"], (mutable: { generator: AsyncGenerator<number> }) => mutable.generator);

			const mutable = (await runtime.main.value("mutable x")) as { value: number };
			expect(mutable.value).toBe(0);

			mutable.value = 5;

			await expect(runtime.main.value("x")).resolves.toBe(5);
		} finally {
			createRuntimeCleanup(runtime, registry)();
		}
	});

	test("unwraps whitespace-padded single-element html templates", () => {
		const htlHtml = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
			const span = document.createElement("span");
			for (const value of values) {
				if (value instanceof Node) span.append(value);
				else if (Array.isArray(value)) span.append(...value);
			}
			const hasBoundaryWhitespace =
				(strings[0] ?? "") !== (strings[0] ?? "").trimStart() ||
				(strings[strings.length - 1] ?? "") !== (strings[strings.length - 1] ?? "").trimEnd();
			if (!hasBoundaryWhitespace && span.childElementCount === 1 && span.textContent === "") {
				return span.firstElementChild!;
			}
			if (span.childElementCount === 0) span.textContent = strings.join("");
			return span;
		});
		const html = createObservableHtml(htlHtml);
		const input = document.createElement("input");
		input.name = "input";
		const form = document.createElement("form");
		form.append(input);
		const aside = document.createElement("aside");

		const single = html` ${form} `;
		const multiple = html` ${[form.cloneNode(true), aside]} `;

		expect(single).toBe(form);
		expect(single).toBeInstanceOf(HTMLFormElement);
		expect((single as HTMLFormElement).elements.namedItem("input")).toBeInstanceOf(HTMLInputElement);
		expect(multiple).toBeInstanceOf(HTMLSpanElement);
	});

	test("parses legacy html string interpolations containing markup", () => {
		const htlHtml = vi.fn((_strings: TemplateStringsArray, ...values: unknown[]) => {
			const form = document.createElement("form");
			for (const value of values) {
				if (value instanceof Node) form.append(value);
				else if (Array.isArray(value)) form.append(...value);
				else form.append(String(value));
			}
			return form;
		});
		const html = createObservableHtml(htlHtml);

		const form = html`
			<form>${'<label><input type="checkbox" name="display" value="orbit" checked> orbit</label>'} ${"1 < 2"}</form>
		` as HTMLFormElement;

		expect(form.querySelectorAll("input[name='display']")).toHaveLength(1);
		expect(form.elements.namedItem("display")).toBeInstanceOf(HTMLInputElement);
		expect((form as HTMLFormElement & { display: HTMLInputElement }).display.value).toBe("orbit");
		expect(form.textContent).toContain("1 < 2");
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
			disposed: false,
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
		root.classList.add("root-marker");
		const localHeading = document.createElement("h2");
		localHeading.id = 'local heading"]';
		localHeading.classList.add("slide");
		localHeading.textContent = "Inside";
		root.append(localHeading);
		const outside = document.createElement("section");
		outside.id = "outside-heading";
		outside.classList.add("outside-only", "slide");
		const outsideHeading = document.createElement("h2");
		outsideHeading.textContent = "Outside";
		outside.append(outsideHeading);
		document.body.append(outside);
		const el = document.createElement("div");
		const registry: AttachmentRegistry = {
			baseUrl: "",
			names: new Set(),
			blobUrls: new Map(),
			disposed: false,
			cleanup() {},
		};
		const runtime = createRuntime(root, el, baseOptions, registry);
		const values: Array<{
			rootFound: boolean;
			headings: string[];
			localIdFound: boolean;
			slides: string[];
			customCurrent: number;
			scopedTitle: string;
			globalTitle: string;
			outsideVisible: boolean;
			bodyIsRoot: boolean;
			headIsRoot: boolean;
			rootEvents: number;
			globalEvents: number;
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
				let rootEvents = 0;
				let globalEvents = 0;
				(document as Document & { current?: number }).current = 4;
				document.title = "Scoped title";
				document.addEventListener("pyobservablejs-probe", () => {
					rootEvents += 1;
				});
				window.document.addEventListener("pyobservablejs-probe", () => {
					globalEvents += 1;
				});
				document.dispatchEvent(new Event("pyobservablejs-probe"));
				return {
					rootFound: document.querySelector(".root-marker") === root,
					headings: [...document.querySelectorAll("h2")].map((node) => node.textContent ?? ""),
					localIdFound: document.getElementById('local heading"]') === localHeading,
					slides: [...document.getElementsByClassName("slide")].map((node) => node.textContent ?? ""),
					customCurrent: (document as Document & { current?: number }).current ?? 0,
					scopedTitle: document.title,
					globalTitle: window.document.title,
					outsideVisible:
						document.querySelector(".outside-only") !== null || document.getElementById("outside-heading") !== null,
					bodyIsRoot: document.body === root,
					headIsRoot: document.head === root,
					rootEvents,
					globalEvents,
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
			scopedTitle: "Scoped title",
			globalTitle: "",
			outsideVisible: false,
			bodyIsRoot: true,
			headIsRoot: true,
			rootEvents: 1,
			globalEvents: 0,
			createdTag: "SPAN",
			baseURI: document.baseURI,
		});

		const runtimeDefinition = createRuntimeDefinition(
			{ id: 1, mode: "ojs", value: "" } as Cell,
			{
				body: 'function(){ return document.querySelector(".root-marker")?.textContent; }',
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
		firstRoot.classList.add("root-marker");
		const firstTarget = document.createElement("span");
		firstTarget.id = "shared-target";
		firstTarget.classList.add("first-only");
		firstTarget.textContent = "First";
		firstRoot.append(firstTarget);
		const secondRoot = document.createElement("div");
		secondRoot.classList.add("root-marker");
		const secondTarget = document.createElement("span");
		secondTarget.id = "shared-target";
		secondTarget.classList.add("second-only");
		secondTarget.textContent = "Second";
		secondRoot.append(secondTarget);
		const registry: AttachmentRegistry = {
			baseUrl: "",
			names: new Set(),
			blobUrls: new Map(),
			disposed: false,
			cleanup() {},
		};
		const firstRuntime = createRuntime(firstRoot, document.createElement("div"), baseOptions, registry);
		const secondRuntime = createRuntime(secondRoot, document.createElement("div"), baseOptions, registry);

		try {
			const firstDocument = runtimeDocument(firstRuntime)!;
			const secondDocument = runtimeDocument(secondRuntime)!;

			expect(firstDocument.querySelector(".root-marker")).toBe(firstRoot);
			expect(secondDocument.querySelector(".root-marker")).toBe(secondRoot);
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
			disposed: false,
			cleanup() {},
		};
		const runtime = createRuntime(document.createElement("div"), document.createElement("div"), baseOptions, registry);

		expect(runtimeDocument(runtime)).toBeDefined();
		createRuntimeCleanup(runtime, registry)();

		expect(runtimeDocument(runtime)).toBeUndefined();
	});

	test("resolves notebook-defined view template tags before Notebook Kit display helpers", async () => {
		const registry = registerAttachments({});
		const root = document.createElement("div");
		const runtime = createRuntime(root, document.createElement("div"), baseOptions, registry);
		const notebookNames = new Set(["view"]);
		const view = vi.fn((strings: TemplateStringsArray) => {
			const node = document.createElement("div") as HTMLDivElement & { value: number };
			node.textContent = strings[0];
			node.value = 42;
			return node;
		});

		try {
			runtime.main.define("view", [], () => view);
			runtime.define(
				{
					root,
					expanded: [],
					variables: [],
				},
				createRuntimeDefinition(
					{ id: 1, mode: "ojs", value: "" } as Cell,
					{
						body: "function viewof$panel(view) { return view`<div>${1}</div>`; }",
						inputs: ["view"],
						outputs: [],
						output: "viewof$panel",
						autodisplay: true,
						autoview: true,
						automutable: false,
					} as ReturnType<typeof transpile>,
					{ notebookNames },
				),
			);

			await expect(runtime.main.value("panel")).resolves.toBe(42);
			expect(view).toHaveBeenCalledOnce();
		} finally {
			createRuntimeCleanup(runtime, registry)();
		}
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

function moduleUrl(source: string): string {
	return `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
}
