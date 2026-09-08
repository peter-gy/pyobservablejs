import { afterEach, describe, expect, test } from "vite-plus/test";
import { mountNotebook, type MountedNotebook, type MountOptions } from "../src";

const mounts: MountedNotebook[] = [];
afterEach(() => {
	for (const mount of mounts.splice(0)) mount.dispose();
});

function mount(sources: string[], options: MountOptions = { runtimeProfile: "observable" }) {
	const root = document.createElement("div");
	const notebook = mountNotebook(root, { cells: sources.map((value, id) => ({ id, mode: "ojs", value })) }, options);
	mounts.push(notebook);
	return { notebook, root };
}

describe("authored display bindings", () => {
	test("resolves notebook-defined view template tags in Observable notebooks", async () => {
		const { notebook } = mount([
			'view = (strings) => Object.assign(document.createElement("div"), {value: 42, textContent: strings[0]})',
			"viewof panel = view`ready`",
		]);
		await notebook.ready();
		expect((await notebook.read("panel")).data).toBe(42);
	});

	test("resolves notebook-defined display functions in Observable notebooks", async () => {
		const { notebook } = mount(["display = (value) => `notebook display: ${value}`", 'panel = display("ready")']);
		await notebook.ready();
		expect((await notebook.read("panel")).data).toBe("notebook display: ready");
	});

	test("uses Notebook Kit helpers inside cells defining display and view", async () => {
		const { notebook, root } = mount([
			'display = display("ready")',
			'viewof view = {const input = Object.assign(document.createElement("input"), {value: "choice"}); view(input); return input;}',
		]);
		await notebook.ready();
		expect(root.textContent).toContain("ready");
		expect((await notebook.read("view")).data).toBe("choice");
	});

	test("uses Notebook Kit display helpers in the Notebook Kit profile", async () => {
		const { notebook, root } = mount(
			["display = (value) => `notebook display: ${value}`", 'panel = display("ready")'],
			{},
		);
		await notebook.ready();
		expect((await notebook.read("panel")).data).toBe("ready");
		expect(root.textContent).toContain("ready");
	});
});
