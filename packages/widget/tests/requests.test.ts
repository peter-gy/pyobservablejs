import { createDiagnostic, DiagnosticError, type NotebookRead, type RuntimeValue } from "@pyobservablejs/runtime";
import { isString } from "@pyobservablejs/runtime/values";
import { expect, test, vi } from "vite-plus/test";
import { isRecord } from "../src/model";
import { connectRequests } from "../src/requests";
import type { WireValue } from "../src/values";
import { createView, waitFor, type TestModel } from "./testing";

type NotebookAccess = Parameters<typeof connectRequests>[1];
interface CyclicValue {
	self?: CyclicValue;
}
const envelope = { kind: "observablejs:access", protocol: 1 };

test("publishes metadata after installing the read listener", async () => {
	const model = createView();
	const controller = new AbortController();
	const notebook = fixture();
	model.on("change:_inspection", () => {
		if (model.get("_inspection")?.generation) request(model, "initial", { selector: "rows" });
	});
	connectRequests(model, notebook, controller.signal);
	expect(model.get("_inspection")).toMatchObject({
		generation: generation(model),
		value: { title: "Data notebook", cells: [], imports: [] },
	});
	expect(model.get("_datasets")).toEqual({ generation: generation(model), values: [] });
	expect((await waitFor(() => findResponse(model, "initial"))).content).toMatchObject({ result: { data: 42 } });
	controller.abort();
	expect(model.get("_inspection")).toEqual({});
	expect(model.get("_datasets")).toEqual({});
});

test("publishes dataset changes without republishing static inspection", () => {
	let datasets: NotebookAccess["datasets"] = [];
	const notebook = {
		...fixture(),
		get datasets() {
			return datasets;
		},
	};
	const model = createView();
	const controller = new AbortController();
	const inspectionChanged = vi.fn();
	model.on("change:_inspection", inspectionChanged);
	const publish = connectRequests(model, notebook, controller.signal);
	datasets = [
		{
			cell: 0,
			name: "rows",
			revision: 2,
			kind: "rows",
			rowCount: 3,
			columns: [],
			schemaSource: "sampled",
			sampledRows: 3,
		},
	];
	publish();
	expect(model.get("_datasets")?.values).toEqual(datasets);
	expect(inspectionChanged).toHaveBeenCalledOnce();
	controller.abort();
	publish();
	expect(model.get("_datasets")).toEqual({});
});

test("sends exact binary slices through one comm buffer and forwards read selection", async () => {
	const source = new Uint8Array([99, 1, 2, 3, 99]);
	const read = vi.fn(async () => result(source.subarray(1, 4), "arrow"));
	const { model, controller } = connect(fixture({ read }));
	request(model, "binary", {
		selector: { cell: 3, name: null, path: ["nested", 0] },
		options: { format: "arrow", columns: ["x"], offset: 2, limit: 3, revision: 7 },
	});
	const reply = await waitFor(() => findResponse(model, "binary"));
	expect(read).toHaveBeenCalledWith(
		{ cell: 3, name: null, path: ["nested", 0] },
		expect.objectContaining({
			format: "arrow",
			columns: ["x"],
			offset: 2,
			limit: 3,
			revision: 7,
			signal: expect.any(AbortSignal),
		}),
	);
	expect(reply.content).toMatchObject({
		result: { cell: 3, name: "table", revision: 7, format: "arrow", binary: true },
	});
	if (!isRecord(reply.content) || !isRecord(reply.content.result)) throw new Error("Missing read response");
	expect(reply.content.result).not.toHaveProperty("data");
	expect(reply.buffers).toHaveLength(1);
	const buffer = reply.buffers[0]!;
	source.fill(0);
	expect([...new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)]).toEqual([1, 2, 3]);
	controller.abort();
});

test("cancels a pending read and ignores its late completion", async () => {
	let finish: ((value: NotebookRead) => void) | undefined;
	let pendingSignal: AbortSignal | undefined;
	const notebook = fixture({
		read: (_selector, options) => {
			pendingSignal = options?.signal;
			return new Promise((resolve) => {
				finish = resolve;
			});
		},
	});
	const read = vi.spyOn(notebook, "read");
	const { model, controller } = connect(notebook);
	request(model, "cancelled", { selector: "rows" });
	request(model, "cancelled", { selector: "rows" });
	expect(read).toHaveBeenCalledOnce();
	model.receiveCustom({ ...envelope, type: "cancel", id: "cancelled", generation: generation(model) });
	expect(pendingSignal?.aborted).toBe(true);
	finish?.(result(42));
	await Promise.resolve();
	expect(findResponse(model, "cancelled")).toBeUndefined();
	controller.abort();
});

test("routes a broadcast request to its addressed frontend generation", async () => {
	const model = createView();
	const first = new AbortController();
	const second = new AbortController();
	const firstRead = vi.fn(async () => result(1));
	const secondRead = vi.fn(async () => result(2));
	connectRequests(model, fixture({ read: firstRead }), first.signal);
	connectRequests(model, fixture({ read: secondRead }), second.signal);
	const target = generation(model);
	try {
		request(model, "target", { selector: "rows" }, target);
		const reply = await waitFor(() => findResponse(model, "target"));
		expect(reply.content).toMatchObject({ generation: target, result: { data: 2 } });
		expect(model.sentMessages().filter(({ content }) => isRecord(content) && content.id === "target")).toHaveLength(1);
		expect(firstRead).not.toHaveBeenCalled();
		expect(secondRead).toHaveBeenCalledOnce();
	} finally {
		first.abort();
		second.abort();
	}
});

test("closes the old generation before serving a remounted view", async () => {
	let finish: ((value: NotebookRead) => void) | undefined;
	const first = connect(
		fixture({
			read: () =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		}),
	);
	const oldGeneration = generation(first.model);
	request(first.model, "old", { selector: "rows" });
	const next = new AbortController();
	connectRequests(first.model, fixture(), next.signal);
	const currentGeneration = generation(first.model);
	expect(currentGeneration).not.toBe(oldGeneration);
	first.controller.abort();
	expect(generation(first.model)).toBe(currentGeneration);
	expect(first.model.get("_datasets")?.generation).toBe(currentGeneration);
	finish?.(result(9));
	await Promise.resolve();
	expect(findResponse(first.model, "old")).toBeUndefined();
	request(first.model, "stale", { selector: "rows" }, oldGeneration);
	request(first.model, "current", { selector: "rows" });
	expect((await waitFor(() => findResponse(first.model, "current"))).content).toMatchObject({ result: { data: 42 } });
	expect(findResponse(first.model, "stale")).toBeUndefined();
	next.abort();
});

test("preserves tagged scalar values and genuine user tag keys in explicit JSON reads", async () => {
	const data = {
		__observablejs_type__: "summary",
		value: "authored",
		count: 12n,
		day: new Date("2030-01-02T00:00:00Z"),
	};
	const read = vi.fn(async () => result(data));
	const { model, controller } = connect(fixture({ read }));
	request(model, "json", { selector: "value", options: { format: "json" } });
	expect((await waitFor(() => findResponse(model, "json"))).content).toMatchObject({
		result: {
			format: "json",
			data: {
				__observablejs_type__: "object",
				value: {
					__observablejs_type__: "summary",
					value: "authored",
					count: { __observablejs_type__: "bigint", value: "12" },
					day: { __observablejs_type__: "datetime", value: "2030-01-02T00:00:00.000Z" },
				},
			},
		},
	});
	expect(read).toHaveBeenCalledWith("value", expect.objectContaining({ format: "native" }));
	controller.abort();
});

test.each(["json", "rows"] as const)("reads shared coordinate arrays as detached %s values", async (format) => {
	const coordinates = [12.5, 48.25];
	const data = [{ properties: { coordinates }, geometry: { type: "Point", coordinates } }];
	const { model, controller } = connect(fixture({ read: async () => result(data) }));
	request(model, "shared", { selector: "geoJSON", options: { format } });
	expect((await waitFor(() => findResponse(model, "shared"))).content).toMatchObject({
		result: {
			format,
			data: [
				{
					properties: { coordinates: [12.5, 48.25] },
					geometry: { type: "Point", coordinates: [12.5, 48.25] },
				},
			],
		},
	});
	controller.abort();
});

test("preserves maps and sets containing shared values in JSON reads", async () => {
	const point = { x: 2 };
	const data = { positions: new Map([["start", point]]), selected: new Set([point]) };
	const { model, controller } = connect(fixture({ read: async () => result(data) }));
	request(model, "collections", { selector: "value", options: { format: "json" } });
	expect((await waitFor(() => findResponse(model, "collections"))).content).toMatchObject({
		result: {
			data: {
				positions: { __observablejs_type__: "map", value: [["start", { x: 2 }]] },
				selected: { __observablejs_type__: "set", value: [{ x: 2 }] },
			},
		},
	});
	controller.abort();
});

test.each([
	["function", () => () => 1],
	["DOM element", () => document.createElement("div")],
	["binary", () => new Uint8Array([1, 2])],
	["array metadata", () => Object.assign([1, 2], { columns: ["value"] })],
	["fractional array property", () => Object.assign([1], { "0.5": 2 })],
	["NaN array property", () => Object.assign([1], { NaN: 2 })],
	["symbol property", () => ({ [Symbol("field")]: 3 })],
	[
		"shared sparse expansion",
		() => {
			const sparse: number[] = [];
			sparse.length = 5_000;
			return Array.from({ length: 101 }, () => sparse);
		},
	],
	["oversized text", () => "x".repeat(3_000_000)],
	[
		"cycle",
		() => {
			const value: CyclicValue = {};
			value.self = value;
			return value;
		},
	],
] as const)("rejects lossy %s JSON reads with a format or projection alternative", async (_name, makeValue) => {
	const { model, controller } = connect(fixture({ read: async () => result(makeValue()) }));
	request(model, "lossy", { selector: "value", options: { format: "json" } });
	expect((await waitFor(() => findResponse(model, "lossy"))).content).toMatchObject({
		error: { name: "TypeError", message: expect.stringContaining("Arrow") },
	});
	controller.abort();
});

test("rejects accessor values before invoking their getters", async () => {
	const getter = vi.fn(() => 42);
	const value = Object.defineProperty({}, "answer", { enumerable: true, get: getter });
	const { model, controller } = connect(fixture({ read: async () => result(value) }));
	request(model, "accessor", { selector: "value" });
	expect((await waitFor(() => findResponse(model, "accessor"))).content).toMatchObject({
		error: { name: "TypeError" },
	});
	expect(getter).not.toHaveBeenCalled();
	controller.abort();
});

test("rejects malformed options before calling the notebook", async () => {
	const notebook = fixture();
	const read = vi.spyOn(notebook, "read");
	const { model, controller } = connect(notebook);
	request(model, "invalid", { selector: "value", options: { offset: -1 } });
	expect((await waitFor(() => findResponse(model, "invalid"))).content).toMatchObject({ error: { name: "TypeError" } });
	expect(read).not.toHaveBeenCalled();
	controller.abort();
});

function fixture(overrides: Partial<NotebookAccess> = {}): NotebookAccess {
	return {
		inspection: {
			title: "Data notebook",
			theme: "air",
			runtimeProfile: "notebook-kit",
			cells: [],
			graph: { cells: [], edges: [] },
			attachments: [],
			imports: [],
		},
		datasets: [],
		read: async () => result(42),
		...overrides,
	};
}

function result(data: RuntimeValue, format: NotebookRead["format"] = "native"): NotebookRead {
	return { cell: 3, name: "table", revision: 7, format, data };
}

function connect(notebook: NotebookAccess) {
	const model = createView();
	const controller = new AbortController();
	connectRequests(model, notebook, controller.signal);
	return { model, controller };
}

function generation(model: TestModel): string {
	const value = model.get("_inspection")?.generation;
	if (!isString(value)) throw new Error("Missing notebook metadata generation");
	return value;
}

function request(model: TestModel, id: string, params: WireValue = {}, target = generation(model)): void {
	model.receiveCustom({ ...envelope, type: "request", id, generation: target, params });
}

function findResponse(model: TestModel, id: string) {
	return model
		.sentMessages()
		.find(({ content }) => isRecord(content) && content.type === "response" && content.id === id);
}

test("reports response transport failures through the view diagnostic boundary", async () => {
	const model = createView();
	const controller = new AbortController();
	const onError = vi.fn();
	connectRequests(model, fixture(), controller.signal, {
		ready: async () => {},
		onError,
		checkpoint: () => ({ readback: model.get("_readback")!, diagnostics: { revision: 1, sequence: 0, errors: [] } }),
	});
	vi.spyOn(model, "send").mockImplementation(() => {
		throw new Error("response transport failed");
	});
	request(model, "broken-transport", { selector: "rows" });
	await expect.poll(() => onError.mock.calls.length).toBe(1);
	expect(onError).toHaveBeenCalledWith(
		expect.objectContaining({ message: "response transport failed" }),
		"send response",
	);
	controller.abort();
});

test("preserves authored diagnostic provenance in failed read responses", async () => {
	const diagnostic = createDiagnostic(
		Object.assign(new Error("authored read failed"), { cause: new TypeError("nested cause") }),
		{
			origin: "notebook",
			phase: "evaluation",
			component: "packages/runtime/src/cell-renderer.ts",
			operation: "evaluate cell",
			variable: "rows",
			cell: {
				index: 2,
				id: 41,
				key: "rows",
				mode: "ojs",
				source: 'rows = (() => {throw new Error("authored read failed")})()',
			},
		},
	);
	const { model, controller } = connect(
		fixture({
			read: async () => {
				throw new DiagnosticError(diagnostic);
			},
		}),
	);
	request(model, "authored-error", { selector: "rows" });
	const response = await waitFor(() => findResponse(model, "authored-error"));
	expect(response.content).toMatchObject({ error: diagnostic });
	controller.abort();
});
