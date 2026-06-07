// @vitest-environment jsdom

import type { RenderProps } from "@anywidget/types";
import { describe, expect, test } from "vitest";
import type { WidgetModel } from "../widget/model";
import { createModel, hasSavedTrait } from "../widget/testing";
import { loadChunkedAnyWidgetApp } from "./chunked-module-loader";

describe("chunked anywidget module loader", () => {
	test("loads Vite chunks through the command channel when traitlet sync does not answer", async () => {
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
		const model = createModel({});
		const el = document.createElement("div");

		const app = await loadChunkedAnyWidgetApp<WidgetModel>(model, "chunks/app.js", new AbortController().signal, {
			createModuleUrl: (source) => `data:text/javascript;base64,${btoa(source)}`,
			invoke: async <T>(name: string, message?: unknown) => {
				expect(name).toBe("read_esm_module");
				const path = typeof message === "object" && message !== null && "path" in message ? String(message.path) : "";
				requested.push(path);
				return [{ path, source: modules.get(path) } as T, [] as DataView[]];
			},
		});
		await app.render({ el } as unknown as RenderProps<WidgetModel>);

		expect(el.textContent).toBe("static dynamic");
		expect(requested).toContain("chunks/app.js");
	});

	test("surfaces module errors returned by the backend", async () => {
		const model = createModel({});

		await expect(
			loadChunkedAnyWidgetApp<WidgetModel>(model, "chunks/app.js", new AbortController().signal, {
				createModuleUrl: (source) => `data:text/javascript;base64,${btoa(source)}`,
				invoke: async <T>(_name: string, message?: unknown) => {
					const path = typeof message === "object" && message !== null && "path" in message ? String(message.path) : "";
					return [{ path, error: "FileNotFoundError: missing app chunk" } as T, [] as DataView[]];
				},
			}),
		).rejects.toThrow("FileNotFoundError: missing app chunk");
	});

	test("loads Vite chunks through traitlet sync when command transport is unavailable", async () => {
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
		const model = createModel({});
		model.on("change:_esm_module_request", () => {
			const request = model.get("_esm_module_request");
			const path = typeof request === "object" && request !== null && "path" in request ? String(request.path) : "";
			requested.push(path);
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			window.setTimeout(() => {
				model.set("_esm_module_response", {
					seq: typeof request === "object" && request !== null && "seq" in request ? request.seq : undefined,
					path,
					source: modules.get(path),
				});
				inFlight -= 1;
			}, 0);
		});
		const el = document.createElement("div");

		const app = await loadChunkedAnyWidgetApp<WidgetModel>(model, "chunks/app.js", new AbortController().signal, {
			createModuleUrl: (source) => `data:text/javascript;base64,${btoa(source)}`,
		});
		await app.render({ el } as unknown as RenderProps<WidgetModel>);

		expect(el.textContent).toBe("static dynamic");
		expect(requested).toContain("chunks/app.js");
		expect(maxInFlight).toBe(1);
		expect(hasSavedTrait(model, "_esm_module_request")).toBe(true);
	});

	test("falls back to traitlet sync when the host does not support commands", async () => {
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
		let invokeCount = 0;
		let inFlight = 0;
		let maxInFlight = 0;
		let unsupportedInvokeSeen = false;
		let pendingResponses: Array<() => void> = [];
		const model = createModel({});
		model.on("change:_esm_module_request", () => {
			const request = model.get("_esm_module_request");
			const path = typeof request === "object" && request !== null && "path" in request ? String(request.path) : "";
			requested.push(path);
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			const respond = () => {
				model.set("_esm_module_response", {
					seq: typeof request === "object" && request !== null && "seq" in request ? request.seq : undefined,
					path,
					source: modules.get(path),
				});
				inFlight -= 1;
			};
			if (unsupportedInvokeSeen) respond();
			else pendingResponses.push(respond);
		});
		const el = document.createElement("div");

		const app = await loadChunkedAnyWidgetApp<WidgetModel>(model, "chunks/app.js", new AbortController().signal, {
			createModuleUrl: (source) => `data:text/javascript;base64,${btoa(source)}`,
			invoke: async () => {
				invokeCount += 1;
				unsupportedInvokeSeen = true;
				for (const respond of pendingResponses) respond();
				pendingResponses = [];
				throw new Error("anywidget.invoke not supported in marimo");
			},
		});
		await app.render({ el } as unknown as RenderProps<WidgetModel>);

		expect(el.textContent).toBe("static dynamic");
		expect(requested).toContain("chunks/app.js");
		expect(invokeCount).toBeGreaterThan(0);
		expect(maxInFlight).toBe(1);
		expect(hasSavedTrait(model, "_esm_module_request")).toBe(true);
	});
});
