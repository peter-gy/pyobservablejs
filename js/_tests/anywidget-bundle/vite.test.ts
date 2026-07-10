import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AnyModel, Experimental, Host } from "@anywidget/types";
import { init, parse } from "es-module-lexer";
import { afterEach, describe, expect, test } from "vitest";
import { build, createServer, normalizePath, type Plugin, type ViteDevServer } from "vite";
import anywidgetBundle, { type AnyWidgetBundleOptions } from "@/anywidget-bundle/vite";

type Manifest = {
	version: number;
	entry: string;
	style: string | null;
	app: string;
	modules: string[];
};

type ModelState = Record<string, unknown>;

type InvalidOptionsCase = {
	label: string;
	overrides: Record<string, unknown>;
	message: string;
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("anywidget bundle Vite plugin", () => {
	test("builds a configured artifact layout and manifest-backed module graph", async () => {
		const fixture = await createFixture({
			"app.ts": `
				import icon from "./icon.svg";
				import "./style.css";
				import { token } from "./shared";
				export default {
				async render({ el }) {
					const lazy = await import("./lazy");
					el.textContent = icon + String(token) + lazy.value;
				}
			};
			`,
			"shared.ts": `export const token = {};`,
			"lazy.ts": `export const value = "lazy";`,
			"style.css": `.fixture { color: rebeccapurple; }`,
			"icon.svg": `<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>`,
		});
		const options = {
			output: {
				entry: "esm/widget.mjs",
				app: "modules/main.mjs",
				style: "styles/widget.css",
			},
		} satisfies Pick<AnyWidgetBundleOptions, "output">;

		await buildFixture(fixture, options);
		const manifest = await readManifest(fixture.outDir);

		expect(manifest).toMatchObject({
			version: 1,
			entry: "esm/widget.mjs",
			style: "styles/widget.css",
			app: "modules/main.mjs",
		});
		expect(manifest.modules).toContain(manifest.app);
		expect(manifest.modules.every((path) => path.startsWith("modules/") && path.endsWith(".mjs"))).toBe(true);
		expect(manifest.modules.some((path) => path !== manifest.app)).toBe(true);
		await init;
		const entry = await readFile(join(fixture.outDir, manifest.entry), "utf8");
		expect(parse(entry)[0].filter((record) => record.n !== undefined)).toHaveLength(0);

		const requests: { path?: unknown }[] = [];
		const controller = new AbortController();
		const entryUrl = `${pathToFileURL(join(fixture.outDir, manifest.entry)).href}?fixture=${Date.now()}`;
		const built = (await import(/* @vite-ignore */ entryUrl)) as {
			default: () => Promise<{
				initialize?(props: unknown): unknown;
			}>;
		};
		const definition = await built.default();
		const pending = Promise.resolve(
			definition.initialize?.({
				model: {
					on() {},
					off() {},
					send(content: { path?: unknown }) {
						requests.push(content);
					},
				},
				signal: controller.signal,
			}),
		);
		await expect.poll(() => requests[0]?.path).toBe(manifest.app);
		controller.abort();
		await pending;

		await Promise.all(
			manifest.modules.map(async (path) => {
				expect((await stat(join(fixture.outDir, path))).isFile()).toBe(true);
			}),
		);
		expect((await stat(join(fixture.outDir, manifest.style ?? "missing-style"))).isFile()).toBe(true);
	});

	test("records a CSS-free bundle explicitly", async () => {
		const fixture = await createFixture({
			"app.ts": `export default { render({ el }) { el.textContent = "ready"; } };`,
		});

		await buildFixture(fixture);
		const manifest = await readManifest(fixture.outDir);

		expect(manifest).toMatchObject({
			entry: "index.js",
			app: "chunks/app.js",
			style: null,
		});
		await expect(stat(join(fixture.outDir, "widget.css"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	test("empties an output directory outside the Vite root", async () => {
		const fixture = await createFixture({
			"app.ts": `export default { render() {} };`,
		});
		const outDir = await mkdtemp(join(tmpdir(), "pyobservablejs-vite-output-"));
		temporaryDirectories.push(outDir);
		const stale = join(outDir, "chunks", "stale.js");
		await mkdir(join(outDir, "chunks"));
		await writeFile(stale, "stale", "utf8");

		await buildFixture({ ...fixture, outDir });

		await expect(stat(stale)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("rejects a cyclic static chunk graph", async () => {
		const fixture = await createFixture({
			"app.ts": `import { a } from "./a"; export default { render() { return a; } };`,
			"a.ts": `import { b } from "./b"; export const a = b + 1;`,
			"b.ts": `import { a } from "./a"; export const b = a + 1;`,
		});

		await expect(
			build({
				configFile: false,
				root: fixture.root,
				logLevel: "silent",
				plugins: [anywidgetBundle({ app: fixture.app, outDir: fixture.outDir })],
				build: {
					rollupOptions: {
						output: {
							manualChunks(id) {
								if (id.endsWith("/a.ts")) return "a";
								if (id.endsWith("/b.ts")) return "b";
							},
						},
					},
				},
			}),
		).rejects.toThrow("Static anywidget bundle import cycle");
	});

	test("rejects emitted files outside the JavaScript graph and widget stylesheet", async () => {
		const fixture = await createFixture({
			"app.ts": `export default { render() {} };`,
		});

		await expect(
			build({
				configFile: false,
				root: fixture.root,
				logLevel: "silent",
				plugins: [
					anywidgetBundle({ app: fixture.app, outDir: fixture.outDir }),
					{
						name: "fixture-extra-asset",
						generateBundle() {
							this.emitFile({ type: "asset", fileName: "extra.txt", source: "extra" });
						},
					},
				],
			}),
		).rejects.toThrow("Unsupported emitted anywidget bundle asset extra.txt");
	});

	test("serves a configured development entry through Vite resolution and anywidget HMR", async () => {
		const fixture = await createFixture({
			"app.ts": `export default { render({ el }) { el.textContent = "development"; } };`,
		});
		const devEntry = "/@weather-widget/entry";
		const plugins = [anywidgetBundle({ app: "@fixture-app", outDir: fixture.outDir, devEntry })];

		const server = await createServer({
			configFile: false,
			root: fixture.root,
			resolve: { alias: { "@fixture-app": fixture.app } },
			plugins,
			server: { middlewareMode: true },
		});
		const modelController = new AbortController();
		const viewController = new AbortController();
		let disposeModel: (() => void | Promise<void>) | undefined;
		let disposeView: (() => void | Promise<void>) | undefined;
		try {
			const transformed = await server.transformRequest(`${devEntry}?anywidget`);
			expect(transformed).not.toBeNull();
			const entryModule = await server.moduleGraph.getModuleByUrl(`${devEntry}?anywidget`);
			const [acceptedApp] = entryModule?.acceptedHmrDeps ?? [];
			expect(acceptedApp?.url).toContain("app.ts");
			expect(entryModule?.importedModules.has(acceptedApp!)).toBe(true);

			const entry = (await server.ssrLoadModule(`${devEntry}?anywidget`)) as {
				default: () => Promise<{
					initialize(props: unknown): unknown;
					render(props: unknown): unknown;
				}>;
			};
			const definition = await entry.default();
			const model = createAnyModel();
			const experimental = createExperimental();
			const initialized = await definition.initialize({ model, signal: modelController.signal, experimental });
			if (typeof initialized === "function") disposeModel = initialized as () => void | Promise<void>;
			const el = { textContent: "" };
			const rendered = await definition.render({
				model,
				el,
				signal: viewController.signal,
				experimental,
				host: createHost(model),
			});
			if (typeof rendered === "function") disposeView = rendered as () => void | Promise<void>;
			expect(el.textContent).toBe("development");
		} finally {
			try {
				try {
					await disposeView?.();
				} finally {
					await disposeModel?.();
				}
			} finally {
				viewController.abort();
				modelController.abort();
				await server.close();
			}
		}
	});

	test("serves an app resolved to a Vite virtual module", async () => {
		const fixture = await createFixture({});
		const devEntry = "/@virtual-widget/entry";
		const appSpecifier = "virtual:fixture-app";
		const appId = "\0virtual:fixture-app";
		const browserAppId = "/@id/__x00__virtual:fixture-app";
		const server = await createServer({
			configFile: false,
			root: fixture.root,
			plugins: [
				fixtureAppPlugin(appSpecifier, appId),
				anywidgetBundle({ app: appSpecifier, outDir: fixture.outDir, devEntry }),
			],
			server: { middlewareMode: true },
		});

		try {
			expect(await developmentImportSpecifiers(server, devEntry)).toContain(browserAppId);
			const acceptedApp = await acceptedDevelopmentApp(server, devEntry);
			expect(acceptedApp.id).toBe(appId);
		} finally {
			await server.close();
		}
	});

	test("serves an app file outside the Vite root through /@fs/", async () => {
		const fixture = await createFixture({});
		const appRoot = await mkdtemp(join(tmpdir(), "pyobservablejs-vite-app-"));
		temporaryDirectories.push(appRoot);
		const app = join(appRoot, "app.ts");
		await writeFile(app, `export default { render() {} };`, "utf8");
		const devEntry = "/@outside-widget/entry";
		const server = await createServer({
			configFile: false,
			root: fixture.root,
			plugins: [anywidgetBundle({ app, outDir: fixture.outDir, devEntry })],
			server: {
				middlewareMode: true,
				fs: { allow: [fixture.root, appRoot] },
			},
		});

		try {
			const resolvedApp = await server.pluginContainer.resolveId(app);
			if (!resolvedApp) throw new Error(`Vite did not resolve ${app}.`);
			const browserAppId = `/@fs/${normalizePath(resolvedApp.id).replace(/^\/+/, "")}`;
			const acceptedApp = await acceptedDevelopmentApp(server, devEntry);
			expect(acceptedApp.id).toBe(resolvedApp.id);
			expect(acceptedApp.url).toBe(browserAppId);
		} finally {
			await server.close();
		}
	});

	test("serves an app resolved to an absolute Windows drive through /@fs/", async () => {
		const fixture = await createFixture({});
		const devEntry = "/@windows-widget/entry";
		const appSpecifier = "virtual:windows-app";
		const appId = "D:/shared/widgets/app.ts";
		const browserAppId = `/@fs/${appId}`;
		const server = await createServer({
			configFile: false,
			root: fixture.root,
			plugins: [
				fixtureAppPlugin(appSpecifier, appId),
				anywidgetBundle({ app: appSpecifier, outDir: fixture.outDir, devEntry }),
			],
			server: { middlewareMode: true },
		});

		try {
			expect(await developmentImportSpecifiers(server, devEntry)).toContain(browserAppId);
			const acceptedApp = await acceptedDevelopmentApp(server, devEntry);
			expect(acceptedApp.id).toBe(appId);
		} finally {
			await server.close();
		}
	});

	test.each(["?", "#"])("rejects a filesystem app path containing %s in build and development", async (delimiter) => {
		const appName = `app${delimiter}.ts`;
		const fixture = await createFixture({
			[appName]: `export default { render() {} };`,
		});
		const app = join(fixture.root, appName);
		const message = "app filesystem paths must not contain ? or #";

		await expect(
			build({
				configFile: false,
				root: fixture.root,
				logLevel: "silent",
				plugins: [anywidgetBundle({ app, outDir: fixture.outDir })],
			}),
		).rejects.toThrow(message);

		const server = await createServer({
			configFile: false,
			root: fixture.root,
			plugins: [anywidgetBundle({ app, outDir: fixture.outDir })],
			server: { middlewareMode: true },
		});
		try {
			await expect(server.transformRequest("/@anywidget-bundle/entry?anywidget")).rejects.toThrow(message);
		} finally {
			await server.close();
		}
	});

	test.each([
		{
			label: "an unknown top-level option",
			overrides: { devEntyr: "/@weather-widget/entry" },
			message: "devEntyr is not supported",
		},
		{ label: "a null output object", overrides: { output: null }, message: "output must be an object" },
		{ label: "a string output object", overrides: { output: "typo" }, message: "output must be an object" },
		{ label: "a null output entry", overrides: { output: { entry: null } }, message: "output.entry" },
		{
			label: "an unpaired surrogate in an output entry",
			overrides: { output: { entry: "\ud800.js" } },
			message: "output.entry",
		},
		{
			label: "an unknown output field",
			overrides: { output: { entyr: "widget.js" } },
			message: "output.entyr is not supported",
		},
	] satisfies InvalidOptionsCase[])("rejects $label", expectInvalidOptions);

	test.each([
		{
			label: "a parent segment in an output entry",
			overrides: { output: { entry: "../widget.js" } },
			message: "output.entry",
		},
		{ label: "an absolute output app path", overrides: { output: { app: "/modules/app.js" } }, message: "output.app" },
		{
			label: "a JavaScript extension for output style",
			overrides: { output: { style: "styles/widget.js" } },
			message: "output.style",
		},
		{
			label: "a Vite placeholder in an output path",
			overrides: { output: { app: "modules/[name].js" } },
			message: "output.app",
		},
		{
			label: "a reserved filesystem component",
			overrides: { output: { app: "modules/CON.js" } },
			message: "output.app",
		},
		{
			label: "a noncanonical Unicode output path",
			overrides: { output: { entry: "A\u0315\u0897.js", app: "a\u0897\u0315.js" } },
			message: "output.entry",
		},
	] satisfies InvalidOptionsCase[])("rejects $label", expectInvalidOptions);

	test.each([
		{
			label: "ASCII case-equivalent artifact paths",
			overrides: { output: { entry: "bundle.js", app: "BUNDLE.js" } },
			message: "must not collide",
		},
		{
			label: "German sharp-s artifact paths",
			overrides: { output: { entry: "straße.js", app: "STRASSE.js" } },
			message: "must not collide",
		},
		{
			label: "Turkish dotted-i artifact paths",
			overrides: { output: { entry: "İ.js", app: "i̇.js" } },
			message: "must not collide",
		},
		{
			label: "Greek sigma artifact paths",
			overrides: { output: { entry: "Σ.js", app: "σ.js" } },
			message: "must not collide",
		},
		{
			label: "canonically equivalent artifact paths",
			overrides: { output: { entry: "é.js", app: "é.js" } },
			message: "must not collide",
		},
		{
			label: "Georgian case-equivalent artifact paths",
			overrides: { output: { entry: "Ᲊ.js", app: "ᲊ.js" } },
			message: "must not collide",
		},
		{
			label: "Latin case-equivalent artifact paths",
			overrides: { output: { entry: "Ɤ.js", app: "ɤ.js" } },
			message: "must not collide",
		},
		{
			label: "Garay case-equivalent artifact paths",
			overrides: { output: { entry: "𐵐.js", app: "𐵰.js" } },
			message: "must not collide",
		},
		{
			label: "Beria Erfe case-equivalent artifact paths",
			overrides: { output: { entry: "𖺠.js", app: "𖺻.js" } },
			message: "must not collide",
		},
		{
			label: "mixed-script case-equivalent artifact paths",
			overrides: { output: { entry: "AΣ𐵐.js", app: "aσ𐵰.js" } },
			message: "must not collide",
		},
		{
			label: "an artifact path and its descendant",
			overrides: { output: { entry: "bundle.js", style: "bundle.js/widget.css" } },
			message: "must not collide",
		},
	] satisfies InvalidOptionsCase[])("rejects $label", expectInvalidOptions);

	test.each([
		{
			label: "a query in the development entry",
			overrides: { devEntry: "/@weather-widget/entry?anywidget" },
			message: "devEntry",
		},
		{
			label: "encoded traversal in the development entry",
			overrides: { devEntry: "/weather/%2e%2e/entry" },
			message: "devEntry",
		},
	] satisfies InvalidOptionsCase[])("rejects $label", expectInvalidOptions);

	test("builds an astral Unicode artifact path", async () => {
		const fixture = await createFixture({
			"app.ts": `export default { render() {} };`,
		});

		await buildFixture(fixture, { output: { entry: "😀.js" } });
		const manifest = await readManifest(fixture.outDir);

		expect(manifest.entry).toBe("😀.js");
		expect((await stat(join(fixture.outDir, manifest.entry))).isFile()).toBe(true);
	});
});

async function createFixture(files: Readonly<Record<string, string>>) {
	const root = await mkdtemp(join(tmpdir(), "pyobservablejs-vite-"));
	temporaryDirectories.push(root);
	await Promise.all(Object.entries(files).map(([path, source]) => writeFile(join(root, path), source, "utf8")));
	return { root, app: join(root, "app.ts"), outDir: join(root, "dist") };
}

function expectInvalidOptions({ overrides, message }: InvalidOptionsCase): void {
	const options = {
		app: "src/widget.ts",
		outDir: "dist",
		...overrides,
	} as unknown as AnyWidgetBundleOptions;
	expect(() => anywidgetBundle(options)).toThrow(message);
}

async function buildFixture(
	fixture: Awaited<ReturnType<typeof createFixture>>,
	overrides: Pick<AnyWidgetBundleOptions, "devEntry" | "output"> = {},
): Promise<void> {
	await build({
		configFile: false,
		root: fixture.root,
		logLevel: "silent",
		plugins: [anywidgetBundle({ app: fixture.app, outDir: fixture.outDir, ...overrides })],
	});
}

async function readManifest(outDir: string): Promise<Manifest> {
	return JSON.parse(await readFile(join(outDir, "anywidget.json"), "utf8")) as Manifest;
}

async function developmentImportSpecifiers(server: ViteDevServer, devEntry: string): Promise<(string | undefined)[]> {
	const resolved = await server.pluginContainer.resolveId(`${devEntry}?anywidget`);
	if (!resolved) throw new Error(`Vite did not resolve ${devEntry}.`);
	const loaded = await server.pluginContainer.load(resolved.id);
	const source = typeof loaded === "string" ? loaded : loaded?.code;
	if (typeof source !== "string") throw new Error(`Vite did not load ${devEntry}.`);
	await init;
	return parse(source)[0].map((record) => record.n);
}

async function acceptedDevelopmentApp(server: ViteDevServer, devEntry: string) {
	const url = `${devEntry}?anywidget`;
	const transformed = await server.transformRequest(url);
	if (!transformed) throw new Error(`Vite did not transform ${devEntry}.`);
	const entryModule = await server.moduleGraph.getModuleByUrl(url);
	const [acceptedApp] = entryModule?.acceptedHmrDeps ?? [];
	if (!acceptedApp) throw new Error(`Vite did not register an HMR dependency for ${devEntry}.`);
	if (!entryModule?.importedModules.has(acceptedApp)) {
		throw new Error(`The HMR dependency for ${devEntry} is not its imported app module.`);
	}
	return acceptedApp;
}

function fixtureAppPlugin(specifier: string, id: string): Plugin {
	return {
		name: `fixture-app:${specifier}`,
		resolveId(source) {
			if (source === specifier || source === id) return id;
		},
		load(resolvedId) {
			if (resolvedId === id) return `export default { render() {} };`;
		},
	};
}

function createAnyModel(): AnyModel {
	return {
		get() {
			return undefined;
		},
		set() {},
		on() {},
		off() {},
		save_changes() {},
		send() {},
		widget_manager: {
			async get_model<T extends ModelState>(): Promise<AnyModel<T>> {
				return createAnyModel() as unknown as AnyModel<T>;
			},
		},
	};
}

function createExperimental(): Experimental {
	return {
		async invoke<T>(): Promise<[T, DataView[]]> {
			return [undefined as T, []];
		},
	};
}

function createHost(model: AnyModel): Host {
	return {
		async getModel<T extends ModelState>(): Promise<AnyModel<T>> {
			return model as unknown as AnyModel<T>;
		},
		async getWidget() {
			throw new Error("This fixture does not render child widgets.");
		},
	};
}
