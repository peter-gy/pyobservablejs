// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import type { Cell, transpile } from "@observablehq/notebook-kit";
import {
	createFileAttachment,
	createRuntime,
	createRuntimeCleanup,
	createRuntimeDefinition,
	registerAttachments,
	runtimeDocument,
	type AttachmentRegistry,
	type NotebookOptions,
} from "./index";
import { waitFor } from "../widget/testing";

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

	test("scopes the document builtin to the notebook root", async () => {
		const root = document.createElement("div");
		root.className = "observablehq-root";
		const localHeading = document.createElement("h2");
		localHeading.id = 'local heading"]';
		localHeading.textContent = "Inside";
		root.append(localHeading);
		const outside = document.createElement("section");
		outside.id = "outside-heading";
		outside.className = "outside-only";
		outside.innerHTML = "<h2>Outside</h2>";
		document.body.append(outside);
		const el = document.createElement("div");
		const registry: AttachmentRegistry = {
			baseUrl: "",
			names: new Set(),
			cleanup() {},
		};
		const runtime = createRuntime(root, el, baseOptions, registry);
		const values: Array<{
			rootFound: boolean;
			headings: string[];
			localIdFound: boolean;
			outsideVisible: boolean;
			createdTag: string;
		}> = [];

		runtime.main
			.variable({
				pending() {},
				fulfilled(value: unknown) {
					values.push(value as (typeof values)[number]);
				},
				rejected(error: unknown) {
					throw error;
				},
			})
			.define("documentProbe", ["document"], (document: Document) => ({
				rootFound: document.querySelector(".observablehq-root") === root,
				headings: [...document.querySelectorAll("h2")].map((node) => node.textContent ?? ""),
				localIdFound: document.getElementById('local heading"]') === localHeading,
				outsideVisible:
					document.querySelector(".outside-only") !== null || document.getElementById("outside-heading") !== null,
				createdTag: document.createElement("span").tagName,
			}));

		expect(await waitFor(() => values[0])).toEqual({
			rootFound: true,
			headings: ["Inside"],
			localIdFound: true,
			outsideVisible: false,
			createdTag: "SPAN",
		});

		const runtimeDefinition = createRuntimeDefinition(
			{ id: 1, mode: "ojs", value: "" } as Cell,
			{
				body: 'function(){ return document.querySelector(".observablehq-root")?.textContent; }',
				inputs: [],
				outputs: [],
				autodisplay: true,
				autoview: false,
				automutable: false,
			} as ReturnType<typeof transpile>,
			{ document: runtimeDocument(runtime) },
		);
		expect(runtimeDefinition.body()).toBe("Inside");
		createRuntimeCleanup(runtime, registry)();
		outside.remove();
	});

	test("keeps document selectors isolated across simultaneous runtimes", () => {
		const firstRoot = document.createElement("div");
		firstRoot.className = "observablehq-root";
		firstRoot.innerHTML = '<span id="shared-target" class="first-only">First</span>';
		const secondRoot = document.createElement("div");
		secondRoot.className = "observablehq-root";
		secondRoot.innerHTML = '<span id="shared-target" class="second-only">Second</span>';
		const registry: AttachmentRegistry = {
			baseUrl: "",
			names: new Set(),
			cleanup() {},
		};
		const firstRuntime = createRuntime(firstRoot, document.createElement("div"), baseOptions, registry);
		const secondRuntime = createRuntime(secondRoot, document.createElement("div"), baseOptions, registry);

		try {
			const firstDocument = runtimeDocument(firstRuntime)!;
			const secondDocument = runtimeDocument(secondRuntime)!;

			expect(firstDocument.querySelector(".observablehq-root")).toBe(firstRoot);
			expect(secondDocument.querySelector(".observablehq-root")).toBe(secondRoot);
			expect(firstDocument.getElementById("shared-target")?.textContent).toBe("First");
			expect(secondDocument.getElementById("shared-target")?.textContent).toBe("Second");
			expect(firstDocument.querySelector(".second-only")).toBeNull();
			expect(secondDocument.querySelector(".first-only")).toBeNull();
		} finally {
			createRuntimeCleanup(firstRuntime, registry)();
			createRuntimeCleanup(secondRuntime, registry)();
		}
	});

	test("releases runtime scope on cleanup", () => {
		const registry: AttachmentRegistry = {
			baseUrl: "",
			names: new Set(),
			cleanup() {},
		};
		const runtime = createRuntime(document.createElement("div"), document.createElement("div"), baseOptions, registry);

		expect(runtimeDocument(runtime)).toBeDefined();
		createRuntimeCleanup(runtime, registry)();

		expect(runtimeDocument(runtime)).toBeUndefined();
	});

	test("awaits template inputs without replacing the previous value receiver", async () => {
		const definition = createRuntimeDefinition(
			{ id: 1, mode: "md", value: "" } as Cell,
			{
				body: 'function(md, gain) { return {receiver: this, text: md([`${this ? "updated" : "initial"} ${gain}`])}; }',
				inputs: ["md", "gain"],
				outputs: [],
				autodisplay: true,
				autoview: false,
				automutable: false,
			} as ReturnType<typeof transpile>,
		);
		const renderMarkdown = (parts: readonly string[]) => parts[0];
		const previous = { rendered: true };

		await expect(definition.body.call(undefined, Promise.resolve(renderMarkdown), 1)).resolves.toEqual({
			receiver: undefined,
			text: "initial 1",
		});
		await expect(definition.body.call(previous, Promise.resolve(renderMarkdown), 2)).resolves.toEqual({
			receiver: previous,
			text: "updated 2",
		});
	});
});

function last<T>(values: T[]): T | undefined {
	return values[values.length - 1];
}
