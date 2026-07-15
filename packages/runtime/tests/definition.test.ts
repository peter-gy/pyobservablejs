import type { Cell, transpile } from "@observablehq/notebook-kit";
import { describe, expect, test, vi } from "vite-plus/test";
import { registerAttachments } from "../src/attachments";
import { createRuntimeDefinition } from "../src/definition";
import { createRuntime, createRuntimeCleanup, type NotebookOptions } from "../src/environment";

const baseOptions: NotebookOptions = {
	attachments: {},
	baseUrl: "",
	variables: {},
	showSource: false,
};
const observableOptions: NotebookOptions = { ...baseOptions, runtimeProfile: "observable" };

describe("runtime definitions", () => {
	test("resolves notebook-defined view template tags before Notebook Kit display helpers", async () => {
		const registry = registerAttachments({});
		const root = document.createElement("div");
		const runtime = createRuntime(root, document.createElement("div"), observableOptions, registry);
		const notebookNames = new Set(["view"]);
		const view = vi.fn((strings: TemplateStringsArray) => {
			const node = document.createElement("div") as HTMLDivElement & { value: number };
			node.textContent = strings[0];
			node.value = 42;
			return node;
		});

		try {
			runtime.main.define("view", [], () => view);
			runtime.define(
				{
					root,
					expanded: [],
					variables: [],
				},
				createRuntimeDefinition(
					{ id: 1, mode: "ojs", value: "" } as Cell,
					{
						body: "function viewof$panel(view) { return view`<div>${1}</div>`; }",
						inputs: ["view"],
						outputs: [],
						output: "viewof$panel",
						autodisplay: true,
						autoview: true,
						automutable: false,
					} as ReturnType<typeof transpile>,
					{ notebookNames, runtimeProfile: "observable" },
				),
			);

			await expect(runtime.main.value("panel")).resolves.toBe(42);
			expect(view).toHaveBeenCalledOnce();
		} finally {
			createRuntimeCleanup(runtime, registry)();
		}
	});

	test("resolves notebook-defined display functions before Notebook Kit display helpers", async () => {
		const registry = registerAttachments({});
		const root = document.createElement("div");
		const runtime = createRuntime(root, document.createElement("div"), observableOptions, registry);
		const notebookNames = new Set(["display"]);
		const display = vi.fn((value: string) => `notebook display: ${value}`);

		try {
			runtime.main.define("display", [], () => display);
			const definition = createRuntimeDefinition(
				{ id: 1, mode: "ojs", value: "" } as Cell,
				{
					body: "function panel(display) { return display('ready'); }",
					inputs: ["display"],
					outputs: [],
					output: "panel",
					autodisplay: true,
					autoview: false,
					automutable: false,
				} as ReturnType<typeof transpile>,
				{ notebookNames, runtimeProfile: "observable" },
			);
			expect(definition.display).toBe(false);
			runtime.define(
				{
					root,
					expanded: [],
					variables: [],
				},
				definition,
			);

			await expect(runtime.main.value("panel")).resolves.toBe("notebook display: ready");
			expect(display).toHaveBeenCalledOnce();
		} finally {
			createRuntimeCleanup(runtime, registry)();
		}
	});

	test("keeps Notebook Kit display helpers for self-defined display and view cells", () => {
		const notebookNames = new Set(["display", "view"]);
		const displayDefinition = createRuntimeDefinition(
			{ id: 1, mode: "ojs", value: "" } as Cell,
			{
				body: "function display(display) { return display('ready'); }",
				inputs: ["display"],
				outputs: [],
				output: "display",
				autodisplay: true,
				autoview: false,
				automutable: false,
			} as ReturnType<typeof transpile>,
			{ notebookNames, runtimeProfile: "observable" },
		);
		const viewDefinition = createRuntimeDefinition(
			{ id: 2, mode: "ojs", value: "" } as Cell,
			{
				body: "function viewof$view(view) { return view`<button>ready</button>`; }",
				inputs: ["view"],
				outputs: [],
				output: "viewof$view",
				autodisplay: true,
				autoview: true,
				automutable: false,
			} as ReturnType<typeof transpile>,
			{ notebookNames, runtimeProfile: "observable" },
		);

		expect(displayDefinition.display).toBeUndefined();
		expect(viewDefinition.display).toBeUndefined();
	});

	test("keeps Notebook Kit display helpers in the Notebook Kit profile", () => {
		const definition = createRuntimeDefinition(
			{ id: 1, mode: "ojs", value: "" } as Cell,
			{
				body: "function panel(display) { return display('ready'); }",
				inputs: ["display"],
				outputs: [],
				output: "panel",
				autodisplay: true,
				autoview: false,
				automutable: false,
			} as ReturnType<typeof transpile>,
			{ notebookNames: new Set(["display"]) },
		);

		expect(definition.display).toBeUndefined();
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
