import { init, parse } from "es-module-lexer";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { createModuleLoader } from "../src/module-loader.ts";
import type { ModuleReader } from "../src/protocol.ts";
import type { AnyWidgetBundleApp, AnyWidgetBundleAppModule } from "../src/types.ts";
import { createModel, renderProps, type ModuleValue, type TestState } from "./testing.ts";

const controllers: AbortController[] = [];

afterEach(() => {
	for (const controller of controllers.splice(0)) controller.abort();
});

describe("bundle module loader", () => {
	test("executes static, re-exported, and dynamic chunks", async () => {
		const modules = new Map<string, ModuleValue>([
			[
				"modules/main.mjs",
				`import { value } from "./static.mjs";
				export default {
					async render({ el }) {
						const dynamic = await import("./dynamic.mjs");
						el.textContent = value + " " + dynamic.value;
					}
				};`,
			],
			["modules/static.mjs", `export { value } from "../shared/value.mjs";`],
			["shared/value.mjs", `export const value = "static";`],
			["modules/dynamic.mjs", `export const value = "dynamic";`],
		]);
		const source = moduleReader(modules);
		const signal = lifecycleSignal();
		const app = await loadApp(source.reader, signal, "execution", "modules/main.mjs");
		const model = createModel({});
		const el = document.createElement("div");

		await app.render(renderProps(model, el, signal));

		expect(el.textContent).toBe("static dynamic");
		expect(new Set(source.requested)).toEqual(new Set(modules.keys()));
	});

	test("ignores import-looking text in strings and comments", async () => {
		const source = moduleReader(
			new Map([
				[
					"chunks/app.js",
					`const text = "import './ghost.js' and import('./dynamic-ghost.js')";
					// import "./comment.js";
					export default { render({ el }) { el.textContent = text; } };`,
				],
			]),
		);
		const signal = lifecycleSignal();
		const app = await loadApp(source.reader, signal, "syntax");
		const el = document.createElement("div");

		await app.render(renderProps(createModel({}), el, signal));

		expect(el.textContent).toContain("ghost.js");
		expect(source.requested).toEqual(["chunks/app.js"]);
	});

	test("preserves shared module identity across a dynamic chunk", async () => {
		const source = moduleReader(
			new Map([
				[
					"chunks/app.js",
					`import { token } from "./shared.js";
					export default {
						async render({ el }) {
							const lazy = await import("./lazy.js");
							el.textContent = String(token === lazy.token);
						}
					};`,
				],
				["chunks/shared.js", `export const token = {};`],
				["chunks/lazy.js", `export { token } from "./shared.js";`],
			]),
		);
		const signal = lifecycleSignal();
		const app = await loadApp(source.reader, signal, "identity");
		const el = document.createElement("div");

		await app.render(renderProps(createModel({}), el, signal));

		expect(el.textContent).toBe("true");
	});

	test("retries a module after a read failure", async () => {
		let attempts = 0;
		const source = moduleReader(
			new Map([
				[
					"chunks/app.js",
					() => {
						attempts += 1;
						return attempts === 1
							? { error: { code: "not_found", message: "Requested bundle module was not found." } }
							: `export default { render() {} };`;
					},
				],
			]),
		);
		const signal = lifecycleSignal();

		await expect(loadApp(source.reader, signal, "retry")).rejects.toMatchObject({ code: "not_found" });
		await expect(loadApp(source.reader, signal, "retry")).resolves.toMatchObject({
			render: expect.any(Function),
		});
		expect(attempts).toBe(2);
	});

	test("retains module URLs until the loader lifecycle ends", async () => {
		const source = moduleReader(
			new Map([
				["chunks/app.js", `import "./shared.js"; export default { render() {} };`],
				["chunks/shared.js", `export const value = 1;`],
			]),
		);
		const controller = trackedController();
		const created: string[] = [];
		const revoked: string[] = [];
		const originalCreate = URL.createObjectURL.bind(URL);
		const originalRevoke = URL.revokeObjectURL.bind(URL);
		Object.defineProperty(URL, "createObjectURL", {
			configurable: true,
			value: vi.fn(() => {
				const url = `blob:module-${created.length}`;
				created.push(url);
				return url;
			}),
		});
		Object.defineProperty(URL, "revokeObjectURL", {
			configurable: true,
			value: vi.fn((url: string) => revoked.push(url)),
		});

		try {
			const loader = createModuleLoader(source.reader, controller.signal, {
				importModule: async () => ({ default: { render() {} } }),
			});
			await loader.import("chunks/app.js");
			expect(created).toHaveLength(2);
			expect(revoked).toEqual([]);

			controller.abort();
			expect(new Set(revoked)).toEqual(new Set(created));
		} finally {
			Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreate });
			Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originalRevoke });
		}
	});

	test("releases custom module URLs once when the loader lifecycle ends", async () => {
		const source = moduleReader(
			new Map([
				["chunks/app.js", `import "./shared.js"; export default { render() {} };`],
				["chunks/shared.js", `export const value = 1;`],
			]),
		);
		const controller = trackedController();
		const created: string[] = [];
		const revoked: string[] = [];
		const loader = createModuleLoader(source.reader, controller.signal, {
			createModuleUrl(_source, path) {
				const url = `custom:${path}`;
				created.push(url);
				return url;
			},
			importModule: async () => ({ default: { render() {} } }),
			revokeModuleUrl: (url) => revoked.push(url),
		});

		await loader.import("chunks/app.js");
		controller.abort();
		controller.abort();

		expect(new Set(revoked)).toEqual(new Set(created));
		expect(revoked).toHaveLength(created.length);
	});

	test("rejects imports that escape the bundle root", async () => {
		const source = moduleReader(
			new Map([["chunks/app.js", `import "../../outside.js"; export default { render() {} };`]]),
		);

		await expect(loadApp(source.reader, lifecycleSignal(), "escape")).rejects.toThrow("escapes the bundle root");
	});

	test("rejects static import cycles", async () => {
		const source = moduleReader(
			new Map([
				["chunks/app.js", `import "./a.js"; export default { render() {} };`],
				["chunks/a.js", `import "./b.js";`],
				["chunks/b.js", `import "./a.js";`],
			]),
		);

		await expect(loadApp(source.reader, lifecycleSignal(), "cycle")).rejects.toThrow(
			"Static anywidget bundle import cycle",
		);
	});

	test("keeps explicit web module imports native", async () => {
		const source = moduleReader(
			new Map([
				["chunks/app.js", `export default { async render() { await import("https://example.com/module.js"); } };`],
			]),
		);
		let rewritten = "";
		const loader = createModuleLoader(source.reader, lifecycleSignal(), {
			createModuleUrl(moduleSource) {
				rewritten = moduleSource;
				return "data:text/javascript,export default {}";
			},
			importModule: async () => ({ default: { render() {} } }),
		});

		await loader.import("chunks/app.js");
		await init;
		const imports = parse(rewritten)[0];
		expect(imports.map((record) => record.n)).toContain("https://example.com/module.js");
	});

	test("executes variable dynamic imports through the native module loader", async () => {
		const source = moduleReader(
			new Map([
				[
					"chunks/app.js",
					`const url = "data:text/javascript,export const value = 'native'";
					export default {
						async render({ el }) {
							const module = await import(url);
							el.textContent = module.value;
						}
					};`,
				],
			]),
		);
		const signal = lifecycleSignal();
		const app = await loadApp(source.reader, signal, "variable-dynamic");
		const el = document.createElement("div");

		await app.render(renderProps(createModel({}), el, signal));

		expect(el.textContent).toBe("native");
	});
});

type RenderableApp = AnyWidgetBundleApp<TestState> & {
	render: NonNullable<AnyWidgetBundleApp<TestState>["render"]>;
};

async function loadApp(
	reader: ModuleReader,
	signal: AbortSignal,
	scope: string,
	appPath = "chunks/app.js",
): Promise<RenderableApp> {
	const loader = createModuleLoader(reader, signal, {
		createModuleUrl: (source, path) => dataModuleUrl(source, `${scope}-${path}`),
	});
	const loaded = (await loader.import(appPath)) as { default: AnyWidgetBundleAppModule<TestState> };
	const app = await instantiate(loaded.default);
	if (!app.render) throw new Error("Expected a render lifecycle");
	return app as RenderableApp;
}

async function instantiate(module: AnyWidgetBundleAppModule<TestState>): Promise<AnyWidgetBundleApp<TestState>> {
	return typeof module === "function" ? await module() : module;
}

function moduleReader(modules: ReadonlyMap<string, ModuleValue>): { reader: ModuleReader; requested: string[] } {
	const requested: string[] = [];
	return {
		requested,
		reader: {
			async read(path) {
				requested.push(path);
				const configured = modules.get(path);
				const value = typeof configured === "function" ? configured() : configured;
				if (typeof value === "object" && value !== null && "error" in value) {
					throw Object.assign(new Error(value.error.message), { code: value.error.code });
				}
				return typeof value === "string" ? value : "";
			},
			dispose() {},
		},
	};
}

function dataModuleUrl(source: string, identity: string): string {
	return `data:text/javascript;base64,${btoa(source)}#${encodeURIComponent(identity)}`;
}

function lifecycleSignal(): AbortSignal {
	return trackedController().signal;
}

function trackedController(): AbortController {
	const controller = new AbortController();
	controllers.push(controller);
	return controller;
}
