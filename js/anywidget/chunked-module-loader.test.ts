// @vitest-environment jsdom

import type { RenderProps } from "@anywidget/types";
import { describe, expect, test } from "vitest";
import type { WidgetModel } from "../widget/model";
import { createModel, hasSavedTrait, type TestModel } from "../widget/testing";
import { loadChunkedAnyWidgetApp } from "./chunked-module-loader";

const moduleUrl = (source: string) => `data:text/javascript;base64,${btoa(source)}`;

describe("chunked anywidget module loader", () => {
	test("loads static and dynamic Vite chunks through traitlet sync", async () => {
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
			["chunks/static-dependency.js", `export const value = "static";`],
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

		const app = await loadChunkedAnyWidgetApp<WidgetModel>(model, "chunks/app.js", new AbortController().signal, {
			createModuleUrl: moduleUrl,
		});
		await app.render({ el } as unknown as RenderProps<WidgetModel>);

		expect(el.textContent).toBe("static dynamic");
		expect(requested).toEqual(["chunks/app.js", "chunks/static-dependency.js", "chunks/dynamic-dependency.js"]);
		expect(maxInFlight).toBe(1);
		expect(hasSavedTrait(model, "_esm_module_request")).toBe(true);
	});

	test("surfaces backend module errors from traitlet responses", async () => {
		const model = respondingModel(new Map([["chunks/app.js", { error: "FileNotFoundError: missing app chunk" }]]));

		await expect(
			loadChunkedAnyWidgetApp<WidgetModel>(model, "chunks/app.js", new AbortController().signal, {
				createModuleUrl: moduleUrl,
			}),
		).rejects.toThrow("FileNotFoundError: missing app chunk");
		expect(hasSavedTrait(model, "_esm_module_request")).toBe(true);
	});

	test("rejects traitlet responses for the wrong module path", async () => {
		const model = respondingModel(new Map([["chunks/app.js", { path: "chunks/other.js", source: "" }]]));

		await expect(
			loadChunkedAnyWidgetApp<WidgetModel>(model, "chunks/app.js", new AbortController().signal, {
				createModuleUrl: moduleUrl,
			}),
		).rejects.toThrow("Widget module response path mismatch: chunks/other.js");
	});

	test("rejects traitlet responses without source text", async () => {
		const model = respondingModel(new Map([["chunks/app.js", { source: undefined }]]));

		await expect(
			loadChunkedAnyWidgetApp<WidgetModel>(model, "chunks/app.js", new AbortController().signal, {
				createModuleUrl: moduleUrl,
			}),
		).rejects.toThrow("Widget module chunks/app.js did not return source text");
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
			if (name === "change:_esm_module_response") responseListeners.add(callback);
			on(name, callback);
		};
		mutableModel.off = (name?: string | null, callback?: (() => void) | null) => {
			if (name === "change:_esm_module_response" && callback) responseListeners.delete(callback);
			off(name, callback);
		};
		model.on("change:_esm_module_request", () => controller.abort());

		await expect(
			loadChunkedAnyWidgetApp<WidgetModel>(model, "chunks/app.js", controller.signal, {
				createModuleUrl: moduleUrl,
			}),
		).rejects.toThrow("Widget module request aborted");

		expect(responseListeners.size).toBe(0);
		expect(hasSavedTrait(model, "_esm_module_request")).toBe(true);
	});

	test("rejects imports that escape the static root", async () => {
		const model = respondingModel(
			new Map([
				[
					"chunks/app.js",
					`import { value } from "../../escape.js";
					export default {
						render({ el }) {
							el.textContent = value;
						}
					};`,
				],
			]),
		);

		await expect(
			loadChunkedAnyWidgetApp<WidgetModel>(model, "chunks/app.js", new AbortController().signal, {
				createModuleUrl: moduleUrl,
			}),
		).rejects.toThrow("Widget module import escapes static root: ../../escape.js");
	});
});

function respondingModel(
	modules: Map<string, string | { path?: string; source?: string; error?: string }>,
	hooks: {
		requested?: string[];
		onRequest?: () => void;
		onRespond?: () => void;
	} = {},
): TestModel {
	const model = createModel({});
	model.on("change:_esm_module_request", () => {
		const request = model.get("_esm_module_request");
		const seq = typeof request === "object" && request !== null && "seq" in request ? request.seq : undefined;
		const path = typeof request === "object" && request !== null && "path" in request ? String(request.path) : "";
		const record = modules.get(path);
		hooks.requested?.push(path);
		hooks.onRequest?.();
		window.setTimeout(() => {
			const response =
				typeof record === "string"
					? { seq, path, source: record }
					: { seq, path, source: record?.source, error: record?.error, ...record };
			model.set("_esm_module_response", response);
			hooks.onRespond?.();
		}, 0);
	});
	return model;
}
