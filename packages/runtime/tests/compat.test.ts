import { describe, expect, test, vi } from "vite-plus/test";
import { registerAttachments } from "../src/attachments";
import { createGenerators, createObservableHtml, createRuntimeCompatibilityBuiltins } from "../src/compat";
import { createRuntime, createRuntimeCleanup, type NotebookOptions } from "../src/environment";

const baseOptions: NotebookOptions = {
	attachments: {},
	baseUrl: "",
	variables: {},
	showSource: false,
};

type LegacyRequire = {
	(...specifiers: unknown[]): Promise<unknown>;
	resolve(specifier: unknown): string;
	alias(aliases: Record<string, unknown>): LegacyRequire;
};

describe("runtime compatibility", () => {
	test("allows Python variables named require outside legacy runtime compatibility", async () => {
		const registry = registerAttachments({});
		const runtime = createRuntime(
			document.createElement("div"),
			document.createElement("div"),
			{
				...baseOptions,
				variables: { require: "python require" },
			},
			registry,
		);

		try {
			runtime.main.define("requireProbe", ["require"], (require: string) => require);

			await expect(runtime.main.value("requireProbe")).resolves.toBe("python require");
		} finally {
			createRuntimeCleanup(runtime, registry)();
		}
	});

	test("rejects Python variables named require when legacy require is enabled", () => {
		const registry = registerAttachments({});

		try {
			expect(() =>
				createRuntime(
					document.createElement("div"),
					document.createElement("div"),
					{
						...baseOptions,
						runtimeCompatibility: { require: true },
						variables: { require: "shadowed" },
					},
					registry,
				),
			).toThrow("Python variables cannot override Observable runtime builtins: require");
		} finally {
			registry.cleanup();
		}
	});

	test("exposes legacy Observable require in runtime builtins", async () => {
		const registry = registerAttachments({});
		const runtime = createRuntime(
			document.createElement("div"),
			document.createElement("div"),
			{
				...baseOptions,
				runtimeCompatibility: { require: true },
			},
			registry,
		);
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
		const runtime = createRuntime(
			document.createElement("div"),
			document.createElement("div"),
			{
				...baseOptions,
				runtimeCompatibility: { require: true },
			},
			registry,
		);
		const aliasedModule = moduleUrl("export default {label: 'aliased'};");
		const preloadedModule = { label: "preloaded" };
		const preloadedFunction = () => "ready";

		try {
			runtime.main.define("requireApiProbe", ["require"], async (require: LegacyRequire) => {
				const alias = require.alias({
					local: aliasedModule,
					preloadedModule,
					preloadedFunction,
				});
				return {
					d3: require.resolve("d3@7"),
					javascriptPath: require.resolve("geometric@2/src/line.js"),
					textPath: require.resolve("example-package/data.txt"),
					directoryPath: require.resolve("example-package/assets/"),
					scopedPath: require.resolve("@scope/package@1/path.js"),
					reactDom: require.resolve("react-dom"),
					mermaid: require.resolve("mermaid"),
					apacheArrow: require.resolve("apache-arrow"),
					duckdb: require.resolve("@duckdb/duckdb-wasm"),
					protocol: require.resolve("https://cdn.example/module.js"),
					local: require.resolve("./local.js"),
					aliased: await alias("local"),
					preloadedModule: (await alias("preloadedModule")) === preloadedModule,
					preloadedFunction: (await alias("preloadedFunction")) === preloadedFunction,
				};
			});

			await expect(runtime.main.value("requireApiProbe")).resolves.toMatchObject({
				d3: "https://cdn.jsdelivr.net/npm/d3@7/+esm",
				javascriptPath: "https://cdn.jsdelivr.net/npm/geometric@2/src/line.js",
				textPath: "https://cdn.jsdelivr.net/npm/example-package/data.txt",
				directoryPath: "https://cdn.jsdelivr.net/npm/example-package/assets/",
				scopedPath: "https://cdn.jsdelivr.net/npm/@scope/package@1/path.js",
				reactDom: "https://cdn.jsdelivr.net/npm/react-dom/client/+esm",
				mermaid: "https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.esm.min.mjs/+esm",
				apacheArrow: "https://cdn.jsdelivr.net/npm/apache-arrow@17.0.0/+esm",
				duckdb: "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.32.0/+esm",
				protocol: "https://cdn.example/module.js",
				local: "./local.js",
				aliased: { label: "aliased" },
				preloadedModule: true,
				preloadedFunction: true,
			});
		} finally {
			createRuntimeCleanup(runtime, registry)();
		}
	});
	test("keeps observe async while supporting old sync iteration consumers", async () => {
		const dispose = vi.fn();
		const Generators = createGenerators({
			observe(initialize: (change: (value: string) => void) => () => void): AsyncGenerator<string> {
				return (async function* () {
					let value = "";
					const cleanup = initialize((next) => {
						value = next;
					});
					try {
						while (true) yield value;
					} finally {
						cleanup();
					}
				})();
			},
		});

		const generator: AsyncGenerator<string> & Iterable<Promise<string | undefined>> = Generators.observe((change) => {
			change("ready");
			return dispose;
		}) as AsyncGenerator<string> & Iterable<Promise<string | undefined>>;
		await expect(generator.next()).resolves.toEqual({ done: false, value: "ready" });
		const iterator = generator[Symbol.iterator]();
		await expect(iterator.next().value).resolves.toBe("ready");
		await iterator.return?.().value;

		expect(dispose).toHaveBeenCalledOnce();
	});

	test("keeps Notebook Kit html builtin on default runtime compatibility", () => {
		const builtins = createRuntimeCompatibilityBuiltins();

		expect("html" in builtins).toBe(false);
		expect("require" in builtins).toBe(false);
	});

	test("adds legacy html builtin for ObservableHQ compatibility", () => {
		const builtins = createRuntimeCompatibilityBuiltins({ html: true });

		expect("html" in builtins).toBe(true);
	});

	test("adds legacy sync iteration to input generators", async () => {
		const generator = (async function* () {
			while (true) yield "ready";
		})();
		const input = vi.fn((_view: string) => generator);
		const Generators = createGenerators({ input });

		const value = Generators.input("view");

		expect(Symbol.iterator in Object(value)).toBe(true);
		await expect(value.next()).resolves.toEqual({ done: false, value: "ready" });
		const iterator = (value as AsyncGenerator<string> & Iterable<Promise<string | undefined>>)[Symbol.iterator]();
		await expect(iterator.next().value).resolves.toBe("ready");
	});

	test("exposes mutable holders to raw Observable runtime modules", async () => {
		const registry = registerAttachments({});
		const runtime = createRuntime(
			document.createElement("div"),
			document.createElement("div"),
			{
				...baseOptions,
				runtimeCompatibility: { mutable: true },
			},
			registry,
		);

		try {
			runtime.main.define("initial x", [], () => 0);
			runtime.main.define(
				"mutable probe",
				["Mutable", "initial x"],
				(Mutable: new (value: number) => object, x: number) => ({
					mutable: new Mutable(x),
				}),
			);
			runtime.main.variable(true).define("x", ["mutable probe"], ({ mutable }: { mutable: { generator: unknown } }) => {
				return mutable.generator;
			});

			const { mutable } = (await runtime.main.value("mutable probe")) as {
				mutable: {
					value: number;
					next(): Promise<IteratorResult<number>>;
					generator?: unknown;
				};
			};
			expect(typeof mutable.next).toBe("function");
			expect(mutable.generator).toBe(mutable);
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

	test("preserves authored span wrappers in legacy html templates", () => {
		const htlHtml = vi.fn((strings: TemplateStringsArray) => {
			const template = document.createElement("template");
			template.innerHTML = strings.join("");
			return template.content.firstElementChild!;
		});
		const html = createObservableHtml(htlHtml);

		const node = html` <span><button>Run</button></span> `;

		expect(node).toBeInstanceOf(HTMLSpanElement);
		expect((node as HTMLSpanElement).querySelector("button")?.textContent).toBe("Run");
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

	test("keeps unsafe legacy html string interpolations as text", () => {
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

		const form = html` <form>${'<img src="x" onerror="alert(1)"><label>orbit</label>'}</form> ` as HTMLFormElement;

		expect(form.querySelector("img")).toBeNull();
		expect(form.textContent).toContain('<img src="x"');
		expect(form.textContent).toContain("<label>orbit</label>");
	});
});

function moduleUrl(source: string): string {
	return `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
}
