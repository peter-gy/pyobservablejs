import { describe, expect, test } from "vitest";
import type { Plugin, UserConfig } from "vite";
import anywidgetBundle from "@/anywidget-bundle/vite";

describe("anywidget bundle vite plugin", () => {
	test("configures a request-based anywidget library build", async () => {
		const plugin = bundlePlugin();
		const config = await callConfig(plugin, "build");

		expect(config.server).toEqual({ host: "127.0.0.1", port: 5173 });
		expect(config.build?.outDir).toBe("dist/widgets");
		expect(config.build?.lib).toMatchObject({
			entry: {
				index: "client/widget-entry.ts",
				app: "client/widget-app.ts",
			},
			formats: ["es"],
		});
		expect(config.build?.copyPublicDir).toBe(false);
		expect(config.build?.cssCodeSplit).toBe(false);
	});

	test("loads a virtual helper that hides the generated app chunk path from consumers", async () => {
		const plugin = bundlePlugin();
		await callConfig(plugin, "build");

		const source = callLoad(plugin, "\0virtual:anywidget-bundle");

		expect(source).toContain("loadAnyWidgetBundleApp");
		expect(source).toContain("__ANYWIDGET_BUNDLE_APP_MODULE__");
		expect(source).toContain(`moduleDir: "chunks"`);
	});

	test("loads the app module directly during Vite dev", async () => {
		const plugin = bundlePlugin();
		await callConfig(plugin, "serve");

		const source = callLoad(plugin, "\0virtual:anywidget-bundle");

		expect(source).toContain(`import app from "/client/widget-app.ts"`);
		expect(source).toContain("Promise.resolve(app)");
	});

	test("serves the default Python dev entry path", async () => {
		const plugin = bundlePlugin();
		await callConfig(plugin, "serve");
		const resolvedEntry = "\0virtual:anywidget-bundle/entry?anywidget";

		expect(callResolveId(plugin, "/@anywidget-bundle/entry?anywidget")).toBe(resolvedEntry);
		expect(callResolveId(plugin, "/@anywidget-bundle/entry")).toBe(resolvedEntry);
		expect(callLoad(plugin, resolvedEntry)).toContain(`import { loadApp } from "virtual:anywidget-bundle"`);
	});

	test("injects the generated app chunk into the entry bundle", () => {
		const plugin = bundlePlugin();
		const bundle = {
			"index.js": {
				type: "chunk",
				name: "index",
				fileName: "index.js",
				code: `const app = "__ANYWIDGET_BUNDLE_APP_MODULE__";`,
			},
			"chunks/widget-app.js": {
				type: "chunk",
				name: "app",
				fileName: "chunks/widget-app.js",
				code: "",
			},
		};

		callGenerateBundle(plugin, bundle);

		expect(bundle["index.js"].code).toBe(`const app = "chunks/widget-app.js";`);
	});
});

function bundlePlugin(): Plugin {
	return anywidgetBundle({
		entry: "client/widget-entry.ts",
		app: "client/widget-app.ts",
		outDir: "dist/widgets",
		dev: { host: "127.0.0.1", port: 5173 },
		output: { entryFile: "index.js" },
	});
}

async function callConfig(plugin: Plugin, command: "build" | "serve") {
	const hook = configHook(plugin);
	const config = await hook.call(
		errorContext(),
		{},
		{ command, mode: command === "build" ? "production" : "development" },
	);
	if (!config || typeof config !== "object") throw new Error("plugin config hook returned an unexpected value");
	return config as UserConfig;
}

function callLoad(plugin: Plugin, id: string): string {
	const hook = loadHook(plugin);
	const value = hook.call(errorContext(), id);
	if (typeof value !== "string") throw new Error("plugin load hook returned an unexpected value");
	return value;
}

function callGenerateBundle(plugin: Plugin, bundle: unknown): void {
	const hook = generateBundleHook(plugin);
	hook.call(errorContext(), {}, bundle, false);
}

type ConfigHook = (this: unknown, config: unknown, env: { command: "build" | "serve"; mode: string }) => unknown;
type ResolveIdHook = (this: unknown, id: string) => unknown;
type LoadHook = (this: unknown, id: string) => unknown;
type GenerateBundleHook = (this: unknown, options: unknown, bundle: unknown, isWrite: boolean) => void;

function configHook(plugin: Plugin): ConfigHook {
	const hook = plugin.config;
	if (typeof hook === "function") return hook as ConfigHook;
	if (hook && typeof hook === "object" && "handler" in hook) return hook.handler as ConfigHook;
	throw new Error("plugin config hook is not callable");
}

function callResolveId(plugin: Plugin, id: string): unknown {
	const hook = resolveIdHook(plugin);
	return hook.call(errorContext(), id);
}

function resolveIdHook(plugin: Plugin): ResolveIdHook {
	const hook = plugin.resolveId;
	if (typeof hook === "function") return hook as ResolveIdHook;
	if (hook && typeof hook === "object" && "handler" in hook) return hook.handler as ResolveIdHook;
	throw new Error("plugin resolveId hook is not callable");
}

function loadHook(plugin: Plugin): LoadHook {
	const hook = plugin.load;
	if (typeof hook === "function") return hook as LoadHook;
	if (hook && typeof hook === "object" && "handler" in hook) return hook.handler as LoadHook;
	throw new Error("plugin load hook is not callable");
}

function generateBundleHook(plugin: Plugin): GenerateBundleHook {
	const hook = plugin.generateBundle;
	if (typeof hook === "function") return hook as GenerateBundleHook;
	if (hook && typeof hook === "object" && "handler" in hook) return hook.handler as GenerateBundleHook;
	throw new Error("plugin generateBundle hook is not callable");
}

function errorContext() {
	return {
		error(message: string): never {
			throw new Error(message);
		},
		meta: {},
	};
}
