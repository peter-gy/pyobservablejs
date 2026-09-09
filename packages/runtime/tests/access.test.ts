import { afterEach, expect, test, vi } from "vite-plus/test";
import { inspectNotebook, mountNotebook, type MountedNotebook } from "../src";

const mounts: MountedNotebook[] = [];
afterEach(() => {
	for (const mount of mounts.splice(0)) mount.dispose();
});

test.each([
	{ id: 1, mode: "sql" as const, value: "SELECT 1", database: 'var:(await import("npm:x"))', hidden: true },
	{ id: 1, mode: "html" as const, value: "<b>content</b>", output: '{missing = await import("npm:x")}' },
])("inspects imports in $mode template metadata", (cell) => {
	const info = inspectNotebook({ cells: [cell] });
	expect(info.cells[0]?.error).toBeUndefined();
	expect(info.imports).toEqual([
		{
			cell: 0,
			kind: "dynamic",
			source: "npm:x",
			resolved: "https://cdn.jsdelivr.net/npm/x/+esm",
			bindings: [],
			injections: [],
		},
	]);
});

test("inspects constant dynamic import targets and preserves computed targets", () => {
	const info = inspectNotebook({
		cells: [
			{
				id: 1,
				mode: "js",
				value:
					'const a = import(`npm:${"d3"}-array`); const b = import("npm:" + "d3-scale"); const c = import(moduleName);',
			},
			{ id: 2, mode: "ojs", value: 'module = import("example-package/file.js")' },
			{ id: 3, mode: "ojs", value: 'module = import("npm:d3-array")' },
		],
	});
	expect(info.imports.map(({ source, resolved }) => ({ source, resolved }))).toEqual([
		{ source: "npm:d3-array", resolved: "https://cdn.jsdelivr.net/npm/d3-array/+esm" },
		{ source: "npm:d3-scale", resolved: "https://cdn.jsdelivr.net/npm/d3-scale/+esm" },
		{ source: null, resolved: null },
		{ source: "example-package/file.js", resolved: "https://cdn.jsdelivr.net/npm/example-package/file.js/+esm" },
		{ source: "npm:d3-array", resolved: "npm:d3-array" },
	]);
});

test("inspects runtime imports beside erased TypeScript declarations", () => {
	const info = inspectNotebook({
		cells: [
			{
				id: 1,
				mode: "ts",
				value: `
declare function helper(value: string): void;
declare namespace Types { type Name = string; }
import type {Shape} from "npm:example-types";
import {type NumberValue, range} from "npm:d3-array";
const values: number[] = range(3);
`,
			},
		],
	});
	expect(info.cells[0]?.error).toBeUndefined();
	expect(info.imports).toEqual([
		{
			cell: 0,
			kind: "static",
			source: "npm:d3-array",
			resolved: "https://cdn.jsdelivr.net/npm/d3-array/+esm",
			bindings: [{ imported: "range", local: "range" }],
			injections: [],
		},
	]);
});

test("inspects complete source, imports, attachments, and diagnostics without evaluating cells", () => {
	const info = inspectNotebook(
		{
			title: "Research source",
			cells: [
				{ id: 11, mode: "ojs", value: "rows = FileAttachment('records.csv').csv()" },
				{ id: 12, mode: "ojs", value: "count = rows.length" },
				{ id: 13, mode: "ojs", value: 'import {chart as plot} with {rows as data} from "@example/charts"' },
				{ id: 14, mode: "ts", value: 'const module = (await import("npm:d3-array@3")) as object;' },
				{ id: 15, mode: "ojs", value: "broken = (" },
				{ id: 16, mode: "js", value: "throw new Error('must not evaluate');" },
			],
		},
		{
			keys: ["data", "count"],
			attachments: { "records.csv": { url: "https://example.test/records.csv", mimeType: "text/csv" } },
		},
	);
	expect(info.cells[0]).toMatchObject({
		index: 0,
		id: 11,
		key: "data",
		source: "rows = FileAttachment('records.csv').csv()",
		files: ["records.csv"],
	});
	expect(info.cells[4]?.error).toContain("SyntaxError");
	expect(info.graph.edges).toContainEqual({ from: 11, to: 12, variable: "rows" });
	expect(info.imports).toEqual([
		{
			cell: 2,
			kind: "static",
			source: "@example/charts",
			resolved: "https://api.observablehq.com/@example/charts.js?v=4",
			bindings: [{ imported: "chart", local: "plot" }],
			injections: [{ imported: "rows", local: "data" }],
		},
		{
			cell: 3,
			kind: "dynamic",
			source: "npm:d3-array@3",
			resolved: "https://cdn.jsdelivr.net/npm/d3-array@3/+esm",
			bindings: [],
			injections: [],
		},
	]);
	expect(info.attachments).toEqual([
		{ name: "records.csv", url: "https://example.test/records.csv", mimeType: "text/csv", cells: [0] },
	]);
	expect(Object.isFrozen(info.cells[0]?.references)).toBe(true);
});

test("reads hidden native datasets independently of preview capture and leaves unrelated cells unevaluated", async () => {
	const rows = [
		{ x: 1, label: "a" },
		{ x: 2, label: "b" },
	];
	const touched = vi.fn();
	const mount = mountNotebook(
		document.createElement("div"),
		{
			cells: [
				{ id: 1, mode: "ojs", value: "records = sourceRows" },
				{ id: 2, mode: "ojs", value: "count = records.length" },
				{ id: 3, mode: "ojs", value: "unrelated = touched()" },
			],
		},
		{ selection: [1], variables: { sourceRows: rows, touched }, captureState: false },
	);
	mounts.push(mount);
	expect((await mount.read("records")).data).toBe(rows);
	expect((await mount.read("records", { format: "rows", columns: ["x"], offset: 1, limit: 1 })).data).toEqual([
		{ x: 2 },
	]);
	expect(mount.datasets).toContainEqual(
		expect.objectContaining({ cell: 0, name: "records", rowCount: 2, kind: "rows" }),
	);
	expect(mount.inspection?.cells).toHaveLength(3);
	expect(mount.state.inputRevision).toBeNull();
	expect(touched).not.toHaveBeenCalled();
	await expect(mount.read("unrelated")).rejects.toThrow("outside the evaluated selection");
	const descriptor = mount.datasets[0]!;
	mount.updateVariables({ sourceRows: [{ x: 3, label: "c" }] });
	await expect(mount.read(descriptor, { revision: descriptor.revision })).rejects.toThrow("stale");
	expect((await mount.read("records", { format: "rows" })).data).toEqual([{ x: 3, label: "c" }]);
});

test("reads anonymous results and own data paths without invoking getters", async () => {
	const getter = vi.fn(() => 42);
	const bundle = {
		rows: [{ x: 7 }],
		get secret() {
			return getter();
		},
	};
	const mount = mountNotebook(
		document.createElement("div"),
		{
			cells: [
				{ id: 1, mode: "ojs", value: "bundle" },
				{ id: 2, mode: "ojs", value: "data = bundle" },
			],
		},
		{ variables: { bundle }, captureState: false },
	);
	mounts.push(mount);
	expect((await mount.read({ cell: 0 })).data).toBe(bundle);
	expect((await mount.read({ name: "data", path: ["rows", 0, "x"] })).data).toBe(7);
	getter.mockClear();
	await expect(mount.read({ name: "data", path: ["secret"] })).rejects.toThrow("own data property");
	expect(getter).not.toHaveBeenCalled();
});

test("cancels pending reads on abort, input changes, and disposal", async () => {
	let release!: (value: number) => void;
	const pending = new Promise<number>((resolve) => {
		release = resolve;
	});
	const mount = mountNotebook(
		document.createElement("div"),
		{ cells: [{ id: 1, mode: "ojs", value: "result = await pending + x" }] },
		{ variables: { pending, x: 1 }, captureState: false },
	);
	mounts.push(mount);
	const controller = new AbortController();
	const aborted = mount.read("result", { signal: controller.signal });
	controller.abort();
	await expect(aborted).rejects.toThrow("cancelled");
	const changed = mount.read("result");
	mount.updateVariables({ x: 2 });
	await expect(changed).rejects.toThrow("changed");
	const closed = mount.read("result");
	mount.dispose();
	await expect(closed).rejects.toThrow("cancelled");
	release(10);
});

test("reads declared attachments as exact binary data", async () => {
	const mount = mountNotebook(
		document.createElement("div"),
		{ cells: [] },
		{
			attachments: {
				"payload.bin": {
					url: "data:application/octet-stream;base64,AQID",
					mimeType: "application/octet-stream",
					size: 3,
				},
			},
		},
	);
	mounts.push(mount);
	const result = await mount.read({ attachment: "payload.bin" }, { format: "bytes" });
	expect(result.data).toEqual(new Uint8Array([1, 2, 3]));
	expect(result).toMatchObject({
		cell: null,
		name: "payload.bin",
		format: "bytes",
		mimeType: "application/octet-stream",
	});
	await expect(mount.read({ attachment: "missing.bin" }, { format: "bytes" })).rejects.toThrow("Unknown");
	await expect(mount.read({ attachment: "payload.bin" }, { columns: ["x"] })).rejects.toThrow("projection");
});

test("exposes native controls while cell reads default to their input values", async () => {
	const el = document.createElement("div");
	const mount = mountNotebook(
		el,
		{
			cells: [
				{
					id: 1,
					mode: "ojs",
					value: 'viewof amount = Object.assign(document.createElement("input"), {type: "number", value: "2"})',
				},
			],
		},
		{ captureState: false },
	);
	mounts.push(mount);
	expect((await mount.read({ cell: 0 })).data).toBe(2);
	expect((await mount.read("viewof$amount")).data).toBe(el.querySelector("input"));
	await expect(mount.read({ cell: 0 }, { format: "bytes", columns: ["x"] })).rejects.toThrow("projection");
});

test("rejects dataset descriptors from a different mount", async () => {
	const source = { cells: [{ id: 1, mode: "ojs" as const, value: "rows = [{x: 1}]" }] };
	const first = mountNotebook(document.createElement("div"), source);
	const second = mountNotebook(document.createElement("div"), source);
	mounts.push(first, second);
	await first.read("rows");
	await second.read("rows");
	await expect(second.read(first.datasets[0]!)).rejects.toThrow("another notebook mount");
});

test("refreshes dataset snapshots across input invalidation, native mutation, and replacement", async () => {
	const rows = [{ x: 1 }];
	const mount = mountNotebook(
		document.createElement("div"),
		{
			cells: [{ id: 1, mode: "ojs", value: "rows = sourceRows" }],
		},
		{ variables: { sourceRows: rows }, captureState: false },
	);
	mounts.push(mount);
	await mount.read("rows");
	const before = mount.datasets;
	expect(mount.datasets).toBe(before);
	expect((await mount.read(before[0]!)).data).toBe(rows);
	rows.push({ x: 2 });
	mount.updateVariables({ sourceRows: rows });
	expect(mount.datasets).toEqual([]);
	await mount.read("rows");
	expect(mount.datasets[0]?.rowCount).toBe(2);
	expect(mount.datasets[0]?.revision).toBeGreaterThan(before[0]!.revision);
	expect(before[0]?.rowCount).toBe(1);
	mount.replaceVariables({ sourceRows: [{ x: 3 }] });
	expect(mount.datasets).toEqual([]);
	await mount.read("rows");
	expect(mount.datasets[0]?.rowCount).toBe(1);
	mount.dispose();
	expect(mount.datasets).toEqual([]);
});

test("qualified value selectors preserve anonymous and multi-output identity", async () => {
	const mount = mountNotebook(
		document.createElement("div"),
		{
			cells: [
				{ id: 1, mode: "ojs", value: "42" },
				{ id: 2, value: "const left = 1; const right = 2;" },
			],
		},
		{ captureState: false },
	);
	mounts.push(mount);
	expect((await mount.read({ cell: 0, name: null })).data).toBe(42);
	await expect(mount.read({ cell: 0, name: "" })).rejects.toThrow("outside the evaluated selection");
	await expect(mount.read({ cell: 1 })).rejects.toThrow("ambiguous");
	expect((await mount.read({ cell: 1, name: "right" })).data).toBe(2);
});
