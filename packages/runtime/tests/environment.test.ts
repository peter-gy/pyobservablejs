import type { RuntimeValue } from "@observablehq/runtime";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { registerAttachments, type AttachmentRegistry } from "../src/attachments";
import { createRuntime, createRuntimeCleanup, type NotebookOptions } from "../src/environment";
import { isNumber, isString } from "../src/value-kind";
import { waitFor } from "./testing";

interface ObservableRequire {
	resolve(specifier: string): Promise<string>;
	alias<Aliases extends Record<string, RuntimeValue>>(
		aliases: Aliases,
	): <Name extends Extract<keyof Aliases, string>>(specifier: Name) => Promise<Aliases[Name]>;
}

const baseOptions: NotebookOptions = {
	attachments: {},
	baseUrl: "",
	variables: {},
	showSource: false,
};

describe("runtime environment", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
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
						variables: { FileAttachment: "shadowed", document: "shadowed", invalidation: "shadowed" },
					},
					registry,
				),
			).toThrow("Python variables cannot override Observable runtime builtins: FileAttachment, document, invalidation");
		} finally {
			registry.cleanup();
		}
	});
	test("rejects Python variables that collide with Observable stdlib builtins", () => {
		const registry = registerAttachments({});

		try {
			expect(() =>
				createRuntime(
					document.createElement("div"),
					document.createElement("div"),
					{ ...baseOptions, runtimeProfile: "observable", variables: { require: "shadowed" } },
					registry,
				),
			).toThrow("Python variables cannot override Observable runtime builtins: require");
		} finally {
			registry.cleanup();
		}
	});
	test("executes checkbox exports from imported Observable modules", async () => {
		const registry = registerAttachments({});
		const runtime = createRuntime(
			document.createElement("div"),
			document.createElement("div"),
			{ ...baseOptions, runtimeProfile: "observable" },
			registry,
		);

		try {
			const imported = runtime.runtime.module((observableRuntime, observer) => {
				const main = observableRuntime.module();
				main
					.variable(observer("checkbox"))
					.define(
						"checkbox",
						["html"],
						(html: (strings: TemplateStringsArray, ...values: RuntimeValue[]) => HTMLElement) => () =>
							html` <form><input name="input" type="checkbox" /></form> `,
					);
				return main;
			});
			runtime.main.import("checkbox", imported);
			runtime.main.define("checkboxFormProbe", ["checkbox"], (checkbox: () => HTMLFormElement) => checkbox());

			const rendered = await runtime.main.value("checkboxFormProbe");
			if (!(rendered instanceof HTMLFormElement)) throw new TypeError("Checkbox probe must render a form");
			const input = rendered.elements.namedItem("input");
			if (!(input instanceof HTMLInputElement)) throw new TypeError("Checkbox probe must render an input");
			const value = () => input.checked;
			expect(value()).toBe(false);
			input.checked = true;
			expect(value()).toBe(true);
		} finally {
			createRuntimeCleanup(runtime, registry)();
		}
	});
	test("renders raw table rows with the Observable html builtin", async () => {
		const registry = registerAttachments({});
		const runtime = createRuntime(
			document.createElement("div"),
			document.createElement("div"),
			{ ...baseOptions, runtimeProfile: "observable" },
			registry,
		);
		const row = '<tr><td><a href="/story">Story</a></td></tr>';

		try {
			runtime.main.define(
				"htmlProbe",
				["html"],
				(html: (strings: TemplateStringsArray, ...values: RuntimeValue[]) => HTMLElement) =>
					html`<table>
						<tbody>
							${row}
						</tbody>
					</table>`,
			);

			const table = await runtime.main.value("htmlProbe");
			if (!(table instanceof HTMLTableElement)) throw new TypeError("HTML probe must render a table");
			expect(table.querySelectorAll("tbody > tr")).toHaveLength(1);
			expect(table.querySelector("a")?.getAttribute("href")).toBe("/story");
		} finally {
			createRuntimeCleanup(runtime, registry)();
		}
	});
	test("resolves versioned modules and preloaded aliases with Observable require", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ name: "d3-format", version: "1.4.5", unpkg: "dist/d3-format.min.js" }), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
			),
		);
		const registry = registerAttachments({});
		const runtime = createRuntime(
			document.createElement("div"),
			document.createElement("div"),
			{ ...baseOptions, runtimeProfile: "observable" },
			registry,
		);
		const fixture = { ready: true };

		try {
			runtime.main.define("requireProbe", ["require"], async (require: ObservableRequire) => ({
				resolved: await require.resolve("d3-format@1"),
				fixture: await require.alias({ fixture })("fixture"),
			}));

			await expect(runtime.main.value("requireProbe")).resolves.toEqual({
				resolved: "https://cdn.jsdelivr.net/npm/d3-format@1.4.5/dist/d3-format.min.js",
				fixture,
			});
		} finally {
			createRuntimeCleanup(runtime, registry)();
		}
	});
	test("disposes values produced by classic Observable generators", async () => {
		const registry = registerAttachments({});
		const runtime = createRuntime(
			document.createElement("div"),
			document.createElement("div"),
			{ ...baseOptions, runtimeProfile: "observable" },
			registry,
		);
		const dispose = vi.fn();
		const values: string[] = [];
		const cleanup = createRuntimeCleanup(runtime, registry);

		try {
			runtime.main
				.variable({
					pending() {},
					fulfilled(value: RuntimeValue) {
						if (!isString(value)) throw new TypeError("Generator probe must publish a string");
						values.push(value);
					},
					rejected(cause: RuntimeValue) {
						throw cause;
					},
				})
				.define(
					"generatorsProbe",
					["Generators"],
					(Generators: { disposable<T>(value: T, dispose: (value: T) => void): Iterable<T> }) =>
						Generators.disposable("ready", dispose),
				);

			expect(await waitFor(() => (values.at(-1) === "ready" ? "ready" : undefined))).toBe("ready");
			cleanup();
			await waitFor(() => (dispose.mock.calls.length === 1 ? true : undefined));
			expect(dispose).toHaveBeenCalledWith("ready");
		} finally {
			cleanup();
		}
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
				this.callback([resizeEntry(width)], this);
			}

			unobserve = vi.fn();
		}
		vi.stubGlobal("ResizeObserver", TestResizeObserver);
		const root = document.createElement("div");
		const el = document.createElement("div");
		root.getBoundingClientRect = () => new DOMRect(0, 0, 400, 0);
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
				fulfilled(value: RuntimeValue) {
					if (!isNumber(value)) throw new TypeError("Width probe must publish a number");
					values.push(value);
				},
				rejected(cause: RuntimeValue) {
					throw cause;
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
		expect(values).toEqual([400, 640]);
	});
	test("reads dark mode from the notebook root", async () => {
		const media = {
			matches: false,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		};
		vi.stubGlobal(
			"matchMedia",
			vi.fn(() => media),
		);
		const previousBodyScheme = document.body.style.colorScheme;
		document.body.style.colorScheme = "light";
		const root = document.createElement("div");
		root.style.colorScheme = "dark";
		const el = document.createElement("div");
		root.append(el);
		document.body.append(root);
		const registry: AttachmentRegistry = {
			baseUrl: "",
			names: new Set(),
			blobUrls: new Map(),
			disposed: false,
			cleanup() {},
		};
		const runtime = createRuntime(root, el, baseOptions, registry);
		runtime.main.define("directDarkProbe", ["dark"], (dark: boolean) => dark);
		runtime.main.define("generatorDarkProbe", ["Generators"], (Generators: { dark(): AsyncGenerator<boolean> }) =>
			Generators.dark(),
		);

		try {
			await expect(runtime.main.value("directDarkProbe")).resolves.toBe(true);
			await expect(runtime.main.value("generatorDarkProbe")).resolves.toBe(true);
		} finally {
			createRuntimeCleanup(runtime, registry)();
			root.remove();
			document.body.style.colorScheme = previousBodyScheme;
		}
	});
});

function last<T>(values: T[]): T | undefined {
	return values[values.length - 1];
}

function resizeEntry(width: number): ResizeObserverEntry {
	const size: ResizeObserverSize = { blockSize: 0, inlineSize: width };
	return {
		target: document.createElement("div"),
		contentRect: new DOMRectReadOnly(0, 0, width, 0),
		borderBoxSize: [size],
		contentBoxSize: [size],
		devicePixelContentBoxSize: [size],
	};
}
