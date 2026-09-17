import { afterEach, expect, test, vi } from "vite-plus/test";
import { isCallable, isObjectValue } from "../src/value-kind";
import { mountNotebook, type MountedNotebook, type NotebookSource } from "../src";

const mounts: MountedNotebook[] = [];
afterEach(() => {
	for (const mount of mounts) mount.dispose();
	mounts.length = 0;
});

test("imports typed declarations through native modules and preserves lazy cells", async () => {
	const resolveNotebook = vi.fn(
		async (): Promise<NotebookSource> => ({
			runtimeProfile: "notebook-kit",
			origin: { id: "0123456789abcdef", version: 1 },
			source: {
				cells: [
					{
						id: 1,
						mode: "ts",
						value: "const base: number = 6; const doubled = base * 2; const evaluations: string[] = [];",
					},
					{ id: 2, mode: "js", value: 'const unused = evaluations.push("unused");' },
				],
			},
		}),
	);
	const mount = mountNotebook(
		document.createElement("div"),
		{
			cells: [
				{ id: 1, mode: "ojs", value: 'import {doubled, evaluations} from "@example/typed"' },
				{ id: 2, mode: "js", value: "const answer = doubled + 1;" },
				{
					id: 3,
					mode: "js",
					value:
						'import define from "observable:@example/typed" with {type: "javascript"}; const isModule = typeof define === "function";',
				},
			],
		},
		{ resolveNotebook },
	);
	mounts.push(mount);
	await mount.ready();
	expect((await mount.read("answer")).data).toBe(13);
	expect((await mount.read("isModule")).data).toBe(true);
	expect((await mount.read("evaluations")).data).toEqual([]);
	expect(resolveNotebook).toHaveBeenCalledTimes(1);
	expect(mount.diagnostics).toEqual([]);
});

test("resolves module URLs against the source base rather than the host page", async () => {
	const mount = mountNotebook(
		document.createElement("div"),
		{
			cells: [
				{ id: 1, mode: "js", value: 'import {url} from "observable:@example/base"; const remote = url;' },
				{ id: 2, mode: "js", value: 'const local = import.meta.resolve("./local.js");' },
			],
		},
		{
			baseUrl: "https://example.test/main/index.html",
			resolveNotebook: async () => ({
				baseUrl: "https://example.test/dependency/index.html",
				source: { cells: [{ id: 1, mode: "js", value: 'const url = import.meta.resolve("./local.js");' }] },
			}),
		},
	);
	mounts.push(mount);
	await mount.ready();
	expect((await mount.read("remote")).data).toBe("https://example.test/dependency/local.js");
	expect((await mount.read("local")).data).toBe("https://example.test/main/local.js");
});

test("updates derived imports and invalidates their resources on replacement and disposal", async () => {
	const mount = mountNotebook(
		document.createElement("div"),
		{
			cells: [
				{ id: 1, mode: "ojs", value: 'import {answer} with {factor} from "@example/scale"' },
				{ id: 2, mode: "ojs", value: "result = answer" },
			],
		},
		{
			variables: { factor: 3 },
			resolveNotebook: async () => ({
				runtimeProfile: "observable",
				source: {
					cells: [
						{ id: 1, mode: "ojs", value: "factor = 1" },
						{
							id: 2,
							mode: "ojs",
							value: `answer = {
								const resource = {value: factor * 2, disposed: false};
								invalidation.then(() => resource.disposed = true);
								return resource;
							}`,
						},
					],
				},
			}),
		},
	);
	mounts.push(mount);
	await mount.ready();
	const initial = (await mount.read("result")).data;
	if (!isObjectValue(initial) || !("disposed" in initial)) throw new Error("Expected the imported resource");
	expect(initial).toEqual({ value: 6, disposed: false });
	mount.updateVariables({ factor: 9 });
	await mount.ready();
	const updated = (await mount.read("result")).data;
	if (!isObjectValue(updated) || !("disposed" in updated)) throw new Error("Expected the updated resource");
	expect(updated).toEqual({ value: 18, disposed: false });
	await vi.waitFor(() => expect(initial.disposed).toBe(true));
	mount.dispose();
	await vi.waitFor(() => expect(updated.disposed).toBe(true));
	expect(mount.diagnostics).toEqual([]);
});

test("imports viewof and mutable bindings with native input and generator semantics", async () => {
	const mount = mountNotebook(
		document.createElement("div"),
		{
			cells: [
				{ id: 1, mode: "ojs", value: 'import {viewof choice, mutable count} from "@example/inputs"' },
				{ id: 2, mode: "ojs", value: "answer = choice + count" },
				{ id: 3, mode: "ojs", value: "increment = () => mutable count++" },
			],
		},
		{
			resolveNotebook: async () => ({
				runtimeProfile: "observable",
				source: {
					cells: [
						{
							id: 1,
							mode: "ojs",
							value: 'viewof choice = Object.assign(document.createElement("input"), {type: "number", value: "4"})',
						},
						{ id: 2, mode: "ojs", value: "mutable count = 2" },
					],
				},
			}),
		},
	);
	mounts.push(mount);
	await mount.ready();
	expect((await mount.read("answer")).data).toBe(6);
	const increment = (await mount.read("increment")).data;
	if (!isCallable(increment)) throw new Error("Expected an imported increment function");
	// SAFETY: The fixture defines increment as a zero-argument function.
	(increment as () => void)();
	await vi.waitFor(async () => expect((await mount.read("answer")).data).toBe(7));
	const input = (await mount.read("viewof$choice")).data;
	if (!(input instanceof HTMLInputElement)) throw new Error("Expected an imported input");
	input.value = "8";
	input.dispatchEvent(new Event("input"));
	await vi.waitFor(async () => expect((await mount.read("answer")).data).toBe(11));
});

test("resolves cyclic notebook imports without recursively evaluating unused cells", async () => {
	const records = {
		"@example/a": {
			runtimeProfile: "notebook-kit",
			origin: { id: "a", version: 1 },
			source: {
				cells: [
					{ id: 1, mode: "js", value: 'import {b} from "observable:@example/b"' },
					{ id: 2, mode: "js", value: "const a = 4; const answer = a + b;" },
				],
			},
		},
		"@example/b": {
			runtimeProfile: "notebook-kit",
			origin: { id: "b", version: 1 },
			source: {
				cells: [
					{ id: 1, mode: "js", value: 'import {a} from "observable:@example/a"' },
					{ id: 2, mode: "js", value: "const b = 3;" },
				],
			},
		},
	} satisfies Record<string, NotebookSource>;
	const catalog = new Map<string, NotebookSource>(Object.entries(records));
	const mount = mountNotebook(
		document.createElement("div"),
		{ cells: [{ id: 1, mode: "ojs", value: 'import {answer} from "@example/a"' }] },
		{ resolveNotebook: async (key) => catalog.get(key)! },
	);
	mounts.push(mount);
	await mount.ready();
	expect((await mount.read("answer")).data).toBe(7);
});

test("keeps attachment registries and transitive revision scopes independent", async () => {
	const records = {
		"@example/a": {
			runtimeProfile: "notebook-kit",
			origin: { id: "a", version: 1, resolutions: { "@example/value": "0000000000000001@1" } },
			attachments: { "data.json": { url: "data:application/json,%7B%22n%22%3A2%7D" } },
			source: {
				cells: [
					{ id: 1, mode: "js", value: 'import {n} from "observable:@example/value"' },
					{ id: 2, mode: "js", value: 'const answer = (await FileAttachment("data.json").json()).n + n;' },
				],
			},
		},
		"@example/b": {
			runtimeProfile: "notebook-kit",
			origin: { id: "b", version: 1, resolutions: { "@example/value": "0000000000000001@2" } },
			attachments: { "data.json": { url: "data:application/json,%7B%22n%22%3A5%7D" } },
			source: {
				cells: [
					{ id: 1, mode: "js", value: 'import {n} from "observable:@example/value"' },
					{ id: 2, mode: "js", value: 'const answer = (await FileAttachment("data.json").json()).n + n;' },
				],
			},
		},
		"0000000000000001@1": {
			runtimeProfile: "observable",
			origin: { id: "0000000000000001", version: 1 },
			source: { cells: [{ id: 1, mode: "ojs", value: "n = 10" }] },
		},
		"0000000000000001@2": {
			runtimeProfile: "observable",
			origin: { id: "0000000000000001", version: 2 },
			source: { cells: [{ id: 1, mode: "ojs", value: "n = 20" }] },
		},
	} satisfies Record<string, NotebookSource>;
	const catalog = new Map<string, NotebookSource>(Object.entries(records));
	const mount = mountNotebook(
		document.createElement("div"),
		{
			cells: [
				{
					id: 1,
					mode: "js",
					value:
						'import {answer as a} from "observable:@example/a"; import {answer as b} from "observable:@example/b"; const total = a + b;',
				},
			],
		},
		{
			origin: { resolutions: { "@example/value": "0000000000000001@999" } },
			resolveNotebook: async (key) => catalog.get(key)!,
		},
	);
	mounts.push(mount);
	await mount.ready();
	expect((await mount.read("a")).data).toBe(12);
	expect((await mount.read("b")).data).toBe(25);
	expect((await mount.read("total")).data).toBe(37);
	mount.dispose();
	expect(mount.diagnostics).toEqual([]);
});

test("derives modern view controls with Observable module value semantics", async () => {
	const mount = mountNotebook(
		document.createElement("div"),
		{ cells: [{ id: 1, mode: "ojs", value: 'import {control, amount} with {factor} from "@example/modern-control"' }] },
		{
			variables: { factor: 3 },
			resolveNotebook: async () => ({
				runtimeProfile: "notebook-kit",
				source: {
					cells: [
						{ id: 1, mode: "js", value: "const factor = 1;" },
						{
							id: 2,
							mode: "js",
							value:
								'const control = Object.assign(document.createElement("input"), {type:"number", value:String(factor)});',
						},
						{ id: 3, mode: "js", value: "const amount = view(control);" },
					],
				},
			}),
		},
	);
	mounts.push(mount);
	await mount.ready();
	expect((await mount.read("amount")).data).toBe("3");
	mount.updateVariables({ factor: 7 });
	await mount.ready();
	expect((await mount.read("amount")).data).toBe("7");
});

test("aborts pending source requests when the mount is disposed", async () => {
	let requestSignal: AbortSignal | undefined;
	const mount = mountNotebook(
		document.createElement("div"),
		{ cells: [{ id: 1, mode: "ojs", value: 'import {answer} from "@example/pending"' }] },
		{
			resolveNotebook: async (_specifier, { signal }) => {
				requestSignal = signal;
				return new Promise<NotebookSource>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				});
			},
		},
	);
	mounts.push(mount);
	await vi.waitFor(() => expect(requestSignal).toBeDefined());
	mount.dispose();
	expect(requestSignal?.aborted).toBe(true);
});
