import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { createModuleReader } from "../src/protocol.ts";
import { respondingModel, sourceBuffer } from "./testing.ts";

const controllers: AbortController[] = [];

afterEach(() => {
	for (const controller of controllers.splice(0)) controller.abort();
});

describe("bundle module protocol", () => {
	test("correlates concurrent binary module reads", async () => {
		const backend = respondingModel(
			new Map([
				["chunks/first.js", "first"],
				["chunks/second.js", "second"],
			]),
			{ delays: { "chunks/first.js": 10, "chunks/second.js": 0 } },
		);
		const controller = trackedController();
		const reader = createModuleReader(backend.model, controller.signal);

		const [first, second] = await Promise.all([reader.read("chunks/first.js"), reader.read("chunks/second.js")]);

		expect(first).toBe("first");
		expect(second).toBe("second");
		expect(backend.maxInFlight).toBe(2);
	});

	test("creates request IDs when randomUUID is unavailable", async () => {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis.crypto, "randomUUID");
		Object.defineProperty(globalThis.crypto, "randomUUID", {
			configurable: true,
			value: undefined,
		});
		try {
			const backend = respondingModel(new Map([["chunks/app.js", "source"]]));
			const reader = createModuleReader(backend.model, trackedController().signal);

			await expect(reader.read("chunks/app.js")).resolves.toBe("source");
			expect(backend.requested).toEqual(["chunks/app.js"]);
		} finally {
			if (descriptor) Object.defineProperty(globalThis.crypto, "randomUUID", descriptor);
			else Reflect.deleteProperty(globalThis.crypto, "randomUUID");
		}
	});

	test("aborts pending reads and removes the message listener", async () => {
		const backend = respondingModel(new Map([["chunks/app.js", "source"]]), { respond: false });
		const controller = trackedController();
		const reader = createModuleReader(backend.model, controller.signal);
		const pending = reader.read("chunks/app.js");

		controller.abort();

		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(backend.listenerCount).toBe(0);
	});

	test("surfaces structured backend errors", async () => {
		const backend = respondingModel(
			new Map([
				["chunks/app.js", { error: { code: "read_failed", message: "Requested bundle module could not be read." } }],
			]),
		);
		const reader = createModuleReader(backend.model, trackedController().signal);

		await expect(reader.read("chunks/app.js")).rejects.toMatchObject({ code: "read_failed" });
	});

	test("rejects responses without one binary source buffer", async () => {
		const backend = respondingModel(new Map([["chunks/app.js", "source"]]), { buffers: [] });
		const reader = createModuleReader(backend.model, trackedController().signal);

		await expect(reader.read("chunks/app.js")).rejects.toMatchObject({ code: "invalid_response" });
	});

	test("rejects responses with multiple binary source buffers", async () => {
		const backend = respondingModel(new Map([["chunks/app.js", "source"]]), {
			buffers: [sourceBuffer("first"), sourceBuffer("second")],
		});
		const reader = createModuleReader(backend.model, trackedController().signal);

		await expect(reader.read("chunks/app.js")).rejects.toMatchObject({ code: "invalid_response" });
	});

	test("rejects module source that is not valid UTF-8", async () => {
		const invalidBytes = Uint8Array.from([0xc3, 0x28]);
		const invalidSource = new DataView(invalidBytes.buffer, invalidBytes.byteOffset, invalidBytes.byteLength);
		const backend = respondingModel(new Map([["chunks/app.js", "source"]]), { buffers: [invalidSource] });
		const reader = createModuleReader(backend.model, trackedController().signal);

		await expect(reader.read("chunks/app.js")).rejects.toMatchObject({ code: "invalid_source" });
	});

	test("rejects responses for another module path", async () => {
		const backend = respondingModel(new Map([["chunks/app.js", "source"]]), {
			responsePath: "chunks/other.js",
		});
		const reader = createModuleReader(backend.model, trackedController().signal);

		await expect(reader.read("chunks/app.js")).rejects.toMatchObject({ code: "path_mismatch" });
	});

	test("times out missing responses", async () => {
		vi.useFakeTimers();
		try {
			const backend = respondingModel(new Map(), { respond: false });
			const reader = createModuleReader(backend.model, trackedController().signal, { timeoutMs: 25 });
			const timedOut = expect(reader.read("chunks/app.js")).rejects.toMatchObject({
				code: "timeout",
			});

			await vi.advanceTimersByTimeAsync(25);
			await timedOut;
		} finally {
			vi.useRealTimers();
		}
	});
});

function trackedController(): AbortController {
	const controller = new AbortController();
	controllers.push(controller);
	return controller;
}
