// @vitest-environment jsdom

import { describe, expect, test } from "vitest";
import { loadWidgetApp } from "./widget/chunk-loader";
import { createModel, hasSavedTrait } from "./widget-test-utils";

describe("widget chunk loader", () => {
	test("loads the generated app chunk through model chunk traits", async () => {
		const sources = new Map([
			[
				"chunks/app-ABCD.js",
				'import{value}from"./chunk-EFGH.js";export const load=()=>import("./lazy-IJKL.js");export default{render(){return value}};',
			],
			["chunks/chunk-EFGH.js", "export const value = 42;"],
			["chunks/lazy-IJKL.js", "export const lazy = true;"],
		]);
		const model = createModel({ role: "notebook", _esm_chunk_request: {}, _esm_chunk_response: {} });
		const requests: string[] = [];
		const createdSources = new Map<string, string>();
		installChunkResponder(model, sources, requests);

		const app = await loadWidgetApp(model, "chunks/app-ABCD.js", new AbortController().signal, {
			createModuleUrl: (source, path) => {
				createdSources.set(path, source);
				return `memory:${path}`;
			},
			importModule: async (url) => {
				expect(url).toBe("memory:chunks/app-ABCD.js");
				return { default: { render: () => undefined } };
			},
		});

		expect(typeof app.render).toBe("function");
		expect(requests).toEqual(["chunks/app-ABCD.js", "chunks/chunk-EFGH.js"]);
		expect(createdSources.get("chunks/app-ABCD.js")).toContain('from"memory:chunks/chunk-EFGH.js"');
		expect(createdSources.get("chunks/app-ABCD.js")).toContain('"chunks/lazy-IJKL.js"');
		expect(createdSources.get("chunks/app-ABCD.js")).not.toContain('import("./lazy-IJKL.js")');
		expect(hasSavedTrait(model, "_esm_chunk_request")).toBe(true);
	});

	test("serializes chunk source requests through the stateful anywidget trait", async () => {
		const sources = new Map([
			[
				"chunks/app-ABCD.js",
				'import{left}from"./left-EFGH.js";import{right}from"./right-IJKL.js";export default{render(){return left + right}};',
			],
			["chunks/left-EFGH.js", "export const left = 1;"],
			["chunks/right-IJKL.js", "export const right = 2;"],
		]);
		const model = createModel({ role: "notebook", _esm_chunk_request: {}, _esm_chunk_response: {} });
		const requests: string[] = [];
		let pending = false;
		model.on("change:_esm_chunk_request", () => {
			const request = model.get("_esm_chunk_request") as { seq?: number; path?: string };
			if (typeof request.path !== "string") return;
			if (pending) throw new Error(`Concurrent chunk request: ${request.path}`);
			pending = true;
			requests.push(request.path);
			window.setTimeout(() => {
				const source = sources.get(request.path!);
				model.set(
					"_esm_chunk_response",
					source === undefined
						? { seq: request.seq, path: request.path, error: `FileNotFoundError: ${request.path}` }
						: { seq: request.seq, path: request.path, source },
				);
				pending = false;
			}, 0);
		});

		await loadWidgetApp(model, "chunks/app-ABCD.js", new AbortController().signal, {
			createModuleUrl: (_source, path) => `memory:${path}`,
			importModule: async () => ({ default: { render: () => undefined } }),
			timeoutMs: 50,
		});

		expect(requests).toEqual(["chunks/app-ABCD.js", "chunks/left-EFGH.js", "chunks/right-IJKL.js"]);
	});

	test("surfaces chunk response errors from the Python model", async () => {
		const model = createModel({ role: "notebook", _esm_chunk_request: {}, _esm_chunk_response: {} });
		installChunkResponder(model, new Map(), []);

		await expect(
			loadWidgetApp(model, "chunks/missing.js", new AbortController().signal, {
				createModuleUrl: () => "memory:missing",
				importModule: async () => ({ default: { render: () => undefined } }),
				timeoutMs: 50,
			}),
		).rejects.toThrow("FileNotFoundError: chunks/missing.js");
	});
});

function installChunkResponder(
	model: ReturnType<typeof createModel>,
	sources: Map<string, string>,
	requests: string[],
): void {
	model.on("change:_esm_chunk_request", () => {
		const request = model.get("_esm_chunk_request") as { seq?: number; path?: string };
		if (typeof request.path !== "string") return;
		requests.push(request.path);
		queueMicrotask(() => {
			const source = sources.get(request.path!);
			model.set(
				"_esm_chunk_response",
				source === undefined
					? { seq: request.seq, path: request.path, error: `FileNotFoundError: ${request.path}` }
					: { seq: request.seq, path: request.path, source },
			);
		});
	});
}
