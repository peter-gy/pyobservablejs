// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import { registerAttachments, type AttachmentRegistry } from "@/runtime/attachments";
import { createRuntime, createRuntimeCleanup, type NotebookOptions } from "@/runtime/environment";
import { waitFor } from "@/_tests/testing";

const baseOptions: NotebookOptions = {
	attachments: {},
	baseUrl: "",
	variables: {},
	showSource: false,
};

describe("runtime environment", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test("rejects Python variables that collide with runtime builtins", () => {
		const registry = registerAttachments({});
		const root = document.createElement("div");
		const el = document.createElement("div");

		try {
			expect(() =>
				createRuntime(
					root,
					el,
					{
						...baseOptions,
						variables: { FileAttachment: "shadowed", document: "shadowed" },
					},
					registry,
				),
			).toThrow("Python variables cannot override Observable runtime builtins: FileAttachment, document");
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
			blobUrls: new Map(),
			disposed: false,
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
		expect(values).toEqual([400, 640]);
	});
	test("reads dark mode from the notebook root", async () => {
		const media = {
			matches: false,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		};
		vi.stubGlobal(
			"matchMedia",
			vi.fn(() => media),
		);
		const previousBodyScheme = document.body.style.colorScheme;
		document.body.style.colorScheme = "light";
		const root = document.createElement("div");
		root.style.colorScheme = "dark";
		const el = document.createElement("div");
		root.append(el);
		document.body.append(root);
		const registry: AttachmentRegistry = {
			baseUrl: "",
			names: new Set(),
			blobUrls: new Map(),
			disposed: false,
			cleanup() {},
		};
		const runtime = createRuntime(root, el, { ...baseOptions, runtimeCompatibility: { generators: true } }, registry);
		runtime.main.define("directDarkProbe", ["dark"], (dark: boolean) => dark);
		runtime.main.define("generatorDarkProbe", ["Generators"], (Generators: { dark(): AsyncGenerator<boolean> }) =>
			Generators.dark(),
		);

		try {
			await expect(runtime.main.value("directDarkProbe")).resolves.toBe(true);
			await expect(runtime.main.value("generatorDarkProbe")).resolves.toBe(true);
		} finally {
			createRuntimeCleanup(runtime, registry)();
			root.remove();
			document.body.style.colorScheme = previousBodyScheme;
		}
	});
});

function last<T>(values: T[]): T | undefined {
	return values[values.length - 1];
}
