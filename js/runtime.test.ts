// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import { createFileAttachment, registerAttachments } from "./runtime/attachments";
import { createRuntime, createRuntimeCleanup } from "./runtime";
import type { AttachmentRegistry, NotebookOptions } from "./runtime/types";
import { waitFor } from "./widget-test-utils";

const baseOptions: NotebookOptions = {
	attachments: {},
	baseUrl: "",
	variables: {},
	showSource: false,
};

describe("runtime bindings", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test("resolves percent-encoded FileAttachment names to registered raw names", async () => {
		const registry = registerAttachments({
			"100% complete.csv": {
				url: "data:text/csv;base64,eA==",
				mimeType: "text/csv",
			},
		});
		const FileAttachment = createFileAttachment("", registry);

		try {
			await expect(FileAttachment("100%25 complete.csv").url()).resolves.toBe("data:text/csv;base64,eA==");
		} finally {
			registry.cleanup();
		}
	});

	test("falls back to the notebook base for unregistered malformed percent names", async () => {
		const registry = registerAttachments({});
		const FileAttachment = createFileAttachment("https://example.test/notebook/", registry);

		try {
			const url = await FileAttachment("missing 100% complete.csv").url();
			const parsed = new URL(url);
			expect(parsed.origin).toBe("https://example.test");
			expect(parsed.pathname).toContain("/notebook/");
			expect(parsed.pathname).toContain("missing");
			expect(parsed.pathname).toContain("complete.csv");
		} finally {
			registry.cleanup();
		}
	});

	test("updates the Observable width builtin when the root resizes", async () => {
		class TestResizeObserver {
			static instances: TestResizeObserver[] = [];
			observing = false;
			observe = vi.fn(() => {
				this.observing = true;
			});
			disconnect = vi.fn(() => {
				this.observing = false;
			});

			constructor(private readonly callback: ResizeObserverCallback) {
				TestResizeObserver.instances.push(this);
			}

			emit(width: number): void {
				if (!this.observing) return;
				this.callback(
					[
						{
							contentRect: { width } as DOMRectReadOnly,
						} as ResizeObserverEntry,
					],
					this as unknown as ResizeObserver,
				);
			}
		}
		vi.stubGlobal("ResizeObserver", TestResizeObserver);
		const root = document.createElement("div");
		const el = document.createElement("div");
		root.getBoundingClientRect = () => ({ width: 400 }) as DOMRect;
		const registry: AttachmentRegistry = {
			baseUrl: "",
			names: new Set(),
			cleanup() {},
		};
		const runtime = createRuntime(root, el, baseOptions, registry);
		const values: number[] = [];

		runtime.main
			.variable({
				pending() {},
				fulfilled(value: unknown) {
					values.push(value as number);
				},
				rejected(error: unknown) {
					throw error;
				},
			})
			.define("observedWidth", ["width"], (width: number) => width);

		expect(await waitFor(() => (last(values) === 400 ? 400 : undefined))).toBe(400);
		const observer = TestResizeObserver.instances[0]!;
		observer.emit(640);
		expect(await waitFor(() => (last(values) === 640 ? 640 : undefined))).toBe(640);
		const cleanup = createRuntimeCleanup(runtime, registry);
		cleanup();
		await waitFor(() => (observer.observing ? undefined : true));
		expect(observer.observing).toBe(false);
		observer.emit(800);
		await new Promise((resolve) => window.setTimeout(resolve, 20));
		expect(values).toEqual([400, 640]);
	});
});

function last<T>(values: T[]): T | undefined {
	return values[values.length - 1];
}
