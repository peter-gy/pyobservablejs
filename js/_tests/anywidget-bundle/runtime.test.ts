// @vitest-environment jsdom

import type { RenderProps } from "@anywidget/types";
import { describe, expect, test, vi } from "vitest";
import { loadAnyWidgetBundleApp } from "@/anywidget-bundle/runtime";

const MODULE_REQUEST_TRAIT = "_anywidget_bundle_module_request";
const MODULE_RESPONSE_TRAIT = "_anywidget_bundle_module_response";
const moduleUrl = (source: string) => `data:text/javascript;base64,${btoa(source)}`;

type TestState = Record<string, unknown>;
type TestModel = RenderProps<TestState>["model"] & {
	savedTraits: Set<string>;
};

describe("anywidget bundle runtime", () => {
	test("loads static, re-exported, and dynamic Vite chunks through traitlet sync", async () => {
		const modules = new Map([
			[
				"chunks/app.js",
				`import { value } from "./static-dependency.js";
				export default {
					async render({ el }) {
						const dynamic = await import("./dynamic-dependency.js");
						el.textContent = [value, dynamic.value].join(" ");
					}
				};`,
			],
			["chunks/static-dependency.js", `export { value } from "./value.js";`],
			["chunks/value.js", `export const value = "static";`],
			["chunks/dynamic-dependency.js", `export const value = "dynamic";`],
		]);
		const requested: string[] = [];
		let inFlight = 0;
		let maxInFlight = 0;
		const model = respondingModel(modules, {
			requested,
			onRequest() {
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
			},
			onRespond() {
				inFlight -= 1;
			},
		});
		const el = document.createElement("div");

		const app = await loadAnyWidgetBundleApp<TestState>(model, "chunks/app.js", new AbortController().signal, {
			createModuleUrl: moduleUrl,
		});
		await app.render({ el } as unknown as RenderProps<TestState>);

		expect(el.textContent).toBe("static dynamic");
		expect(requested).toEqual([
			"chunks/app.js",
			"chunks/static-dependency.js",
			"chunks/value.js",
			"chunks/dynamic-dependency.js",
		]);
		expect(maxInFlight).toBe(1);
		expect(hasSavedTrait(model, MODULE_REQUEST_TRAIT)).toBe(true);
	});

	test("surfaces backend module errors from traitlet responses", async () => {
		const model = respondingModel(new Map([["chunks/app.js", { error: "FileNotFoundError: missing app chunk" }]]));

		await expect(
			loadAnyWidgetBundleApp<TestState>(model, "chunks/app.js", new AbortController().signal, {
				createModuleUrl: moduleUrl,
			}),
		).rejects.toThrow("FileNotFoundError: missing app chunk");
		expect(hasSavedTrait(model, MODULE_REQUEST_TRAIT)).toBe(true);
	});

	test("evicts failed imports so a later request can retry", async () => {
		let attempts = 0;
		const model = respondingModel(
			new Map([
				[
					"chunks/app.js",
					() => {
						attempts += 1;
						return attempts === 1
							? { error: "FileNotFoundError: missing app chunk" }
							: "export default { render({ el }) { el.textContent = 'loaded'; } };";
					},
				],
			]),
		);
		const signal = new AbortController().signal;

		await expect(
			loadAnyWidgetBundleApp<TestState>(model, "chunks/app.js", signal, {
				createModuleUrl: moduleUrl,
			}),
		).rejects.toThrow("FileNotFoundError: missing app chunk");
		const app = await loadAnyWidgetBundleApp<TestState>(model, "chunks/app.js", signal, {
			createModuleUrl: moduleUrl,
		});

		const el = document.createElement("div");
		await app.render({ el } as unknown as RenderProps<TestState>);
		expect(el.textContent).toBe("loaded");
		expect(attempts).toBe(2);
	});

	test("revokes blob module URLs after imports finish", async () => {
		const modules = new Map([
			[
				"chunks/app.js",
				`import { value } from "./value.js";
				export default { render({ el }) { el.textContent = value; } };`,
			],
			["chunks/value.js", `export const value = "loaded";`],
		]);
		const createObjectURL = vi.fn().mockReturnValueOnce("blob:value-module").mockReturnValueOnce("blob:app-module");
		const revokeObjectURL = vi.fn();
		const originalCreateObjectURL = URL.createObjectURL;
		const originalRevokeObjectURL = URL.revokeObjectURL;
		Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
		Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });

		try {
			const app = await loadAnyWidgetBundleApp<TestState>(
				respondingModel(modules),
				"chunks/app.js",
				new AbortController().signal,
				{
					importModule: async () => ({
						default: {
							render({ el }: RenderProps<TestState>) {
								el.textContent = "loaded";
							},
						},
					}),
				},
			);

			const el = document.createElement("div");
			await app.render({ el } as unknown as RenderProps<TestState>);

			expect(el.textContent).toBe("loaded");
			expect(createObjectURL).toHaveBeenCalledTimes(2);
			expect(revokeObjectURL).toHaveBeenCalledWith("blob:value-module");
			expect(revokeObjectURL).toHaveBeenCalledWith("blob:app-module");
		} finally {
			Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreateObjectURL });
			Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originalRevokeObjectURL });
		}
	});

	test("aborts instead of importing a revoked blob module URL", async () => {
		const modules = new Map([["chunks/app.js", `export default { render() {} };`]]);
		const controller = new AbortController();
		const createObjectURL = vi.fn(() => {
			controller.abort();
			return "blob:aborted-module";
		});
		const revokeObjectURL = vi.fn();
		const importModule = vi.fn(async () => ({ default: { render() {} } }));
		const originalCreateObjectURL = URL.createObjectURL;
		const originalRevokeObjectURL = URL.revokeObjectURL;
		Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
		Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });

		try {
			await expect(
				loadAnyWidgetBundleApp<TestState>(respondingModel(modules), "chunks/app.js", controller.signal, {
					importModule,
				}),
			).rejects.toThrow("Anywidget bundle module request aborted");
			expect(revokeObjectURL).toHaveBeenCalledWith("blob:aborted-module");
			expect(importModule).not.toHaveBeenCalled();
		} finally {
			Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreateObjectURL });
			Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originalRevokeObjectURL });
		}
	});

	test("aborts before import when the session is disposed after URL creation", async () => {
		const modules = new Map([["chunks/app.js", `export default { render() {} };`]]);
		const controller = new AbortController();
		const createObjectURL = vi.fn(() => {
			queueMicrotask(() => controller.abort());
			return "blob:queued-abort-module";
		});
		const revokeObjectURL = vi.fn();
		const importModule = vi.fn(async () => ({ default: { render() {} } }));
		const originalCreateObjectURL = URL.createObjectURL;
		const originalRevokeObjectURL = URL.revokeObjectURL;
		Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
		Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });

		try {
			await expect(
				loadAnyWidgetBundleApp<TestState>(respondingModel(modules), "chunks/app.js", controller.signal, {
					importModule,
				}),
			).rejects.toThrow("Anywidget bundle module request aborted");
			expect(revokeObjectURL).toHaveBeenCalledWith("blob:queued-abort-module");
			expect(importModule).not.toHaveBeenCalled();
		} finally {
			Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreateObjectURL });
			Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originalRevokeObjectURL });
		}
	});

	test("rejects traitlet responses for the wrong module path", async () => {
		const model = respondingModel(new Map([["chunks/app.js", { path: "chunks/other.js", source: "" }]]));

		await expect(
			loadAnyWidgetBundleApp<TestState>(model, "chunks/app.js", new AbortController().signal, {
				createModuleUrl: moduleUrl,
			}),
		).rejects.toThrow("Anywidget bundle module response path mismatch: chunks/other.js");
	});

	test("rejects traitlet responses without source text", async () => {
		const model = respondingModel(new Map([["chunks/app.js", { source: undefined }]]));

		await expect(
			loadAnyWidgetBundleApp<TestState>(model, "chunks/app.js", new AbortController().signal, {
				createModuleUrl: moduleUrl,
			}),
		).rejects.toThrow("Anywidget bundle module chunks/app.js did not return source text");
	});

	test("aborts a pending traitlet request and removes the response listener", async () => {
		const model = createModel({});
		const controller = new AbortController();
		const responseListeners = new Set<() => void>();
		const mutableModel = model as unknown as {
			on(name: string, callback: () => void): void;
			off(name?: string | null, callback?: (() => void) | null): void;
		};
		const on = mutableModel.on.bind(mutableModel);
		const off = mutableModel.off.bind(mutableModel);
		mutableModel.on = (name: string, callback: () => void) => {
			if (name === `change:${MODULE_RESPONSE_TRAIT}`) responseListeners.add(callback);
			on(name, callback);
		};
		mutableModel.off = (name?: string | null, callback?: (() => void) | null) => {
			if (name === `change:${MODULE_RESPONSE_TRAIT}` && callback) responseListeners.delete(callback);
			off(name, callback);
		};
		model.on(`change:${MODULE_REQUEST_TRAIT}`, () => controller.abort());

		await expect(
			loadAnyWidgetBundleApp<TestState>(model, "chunks/app.js", controller.signal, {
				createModuleUrl: moduleUrl,
			}),
		).rejects.toThrow("Anywidget bundle module request aborted");

		expect(responseListeners.size).toBe(0);
		expect(hasSavedTrait(model, MODULE_REQUEST_TRAIT)).toBe(true);
	});

	test("rejects imports that escape the module directory", async () => {
		const model = respondingModel(
			new Map([
				[
					"chunks/app.js",
					`import { value } from "../escape.js";
					export default {
						render({ el }) {
							el.textContent = value;
						}
					};`,
				],
			]),
		);

		await expect(
			loadAnyWidgetBundleApp<TestState>(model, "chunks/app.js", new AbortController().signal, {
				createModuleUrl: moduleUrl,
			}),
		).rejects.toThrow("Unsupported anywidget bundle module path: escape.js");
	});
});

function createModel(initial: Partial<TestState>): TestModel {
	const state = new Map<string, unknown>(Object.entries(initial));
	const dirtyTraits = new Set<string>();
	const savedTraits = new Set<string>();
	const listeners = new Map<string, Set<() => void>>();
	return {
		savedTraits,
		get(name: string) {
			return state.get(name);
		},
		set(name: string, value: unknown) {
			state.set(name, value);
			dirtyTraits.add(name);
			for (const listener of listeners.get(`change:${name}`) ?? []) listener();
		},
		save_changes() {
			for (const name of dirtyTraits) savedTraits.add(name);
			dirtyTraits.clear();
		},
		on(name: string, callback: () => void) {
			const callbacks = listeners.get(name) ?? new Set();
			callbacks.add(callback);
			listeners.set(name, callbacks);
		},
		off(name?: string | null, callback?: (() => void) | null) {
			if (name == null) {
				listeners.clear();
				return;
			}
			if (callback == null) {
				listeners.delete(name);
				return;
			}
			listeners.get(name)?.delete(callback);
		},
	} as unknown as TestModel;
}

function hasSavedTrait(model: TestModel, name: string): boolean {
	return model.savedTraits.has(name);
}

type ModuleRecord =
	| string
	| { path?: string; source?: string; error?: string }
	| (() => string | { path?: string; source?: string; error?: string });

function respondingModel(
	modules: Map<string, ModuleRecord>,
	hooks: {
		requested?: string[];
		onRequest?: () => void;
		onRespond?: () => void;
	} = {},
): TestModel {
	const model = createModel({});
	model.on(`change:${MODULE_REQUEST_TRAIT}`, () => {
		const request = model.get(MODULE_REQUEST_TRAIT);
		const seq = typeof request === "object" && request !== null && "seq" in request ? request.seq : undefined;
		const path = typeof request === "object" && request !== null && "path" in request ? String(request.path) : "";
		const record = modules.get(path);
		hooks.requested?.push(path);
		hooks.onRequest?.();
		window.setTimeout(() => {
			const value = typeof record === "function" ? record() : record;
			const response =
				typeof value === "string"
					? { seq, path, source: value }
					: { seq, path, source: value?.source, error: value?.error, ...value };
			model.set(MODULE_RESPONSE_TRAIT, response);
			hooks.onRespond?.();
		}, 0);
	});
	return model;
}
