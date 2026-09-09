import { afterEach, expect, test } from "vite-plus/test";
import { inspectNotebook, mountNotebook, type MountedNotebook } from "../src";
import { waitFor } from "./testing";

const mounts: MountedNotebook[] = [];
afterEach(() => {
	for (const mount of mounts.splice(0)) mount.dispose();
});

test("inspects classic template dependencies and imports while retaining authored source", () => {
	const value = '<div>${viewof slider}${import("example-package/file.js")}</div>';
	const info = inspectNotebook(
		{
			cells: [
				{ id: 1, mode: "ojs", value: 'viewof slider = document.createElement("input")' },
				{ id: 2, mode: "html", value, output: "panel" },
			],
		},
		{ runtimeProfile: "observable" },
	);
	expect(info.cells[1]).toMatchObject({ mode: "html", source: value, defines: ["panel"] });
	expect(info.cells[1]?.error).toBeUndefined();
	expect(info.graph.edges).toContainEqual({ from: 1, to: 2, variable: "viewof$slider" });
	expect(info.imports).toContainEqual({
		cell: 1,
		kind: "dynamic",
		source: "example-package/file.js",
		resolved: "https://cdn.jsdelivr.net/npm/example-package/file.js/+esm",
		bindings: [],
		injections: [],
	});
});

test("renders viewof elements and applies mutable assignments inside HTML interpolation", async () => {
	const root = document.createElement("div");
	const mount = mountNotebook(
		root,
		{
			cells: [
				{ id: 1, mode: "ojs", value: "mutable flag = false" },
				{ id: 2, mode: "ojs", value: 'viewof slider = Object.assign(document.createElement("input"), {value: "3"})' },
				{
					id: 3,
					mode: "html",
					output: "panel",
					value:
						'<div>${viewof slider}${(() => { const button = document.createElement("button"); button.textContent = "toggle"; button.onclick = () => mutable flag = !flag; return button; })()}</div>',
				},
			],
		},
		{ runtimeProfile: "observable" },
	);
	mounts.push(mount);
	await mount.ready();
	const panel = (await mount.read("panel")).data;
	if (!(panel instanceof HTMLElement)) throw new Error("The named HTML template did not produce an element");
	expect(panel.querySelector("input")?.value).toBe("3");
	panel.querySelector("button")!.click();
	await waitFor(() => (mount.state.results[0]?.values.flag === true ? true : undefined));
	expect((await mount.read("flag")).data).toBe(true);
});

test.each(["md", "tex"] as const)("preserves %s literal text and nested template interpolation", async (mode) => {
	const value =
		(mode === "md" ? "Literal \\`tick\\`" : "Literal `tick`") +
		", \\alpha, \\${literal}: ${`nested ${viewof slider.value}`}";
	const mount = mountNotebook(
		document.createElement("div"),
		{
			cells: [
				{ id: 1, mode: "ojs", value: 'viewof slider = Object.assign(document.createElement("input"), {value: "3"})' },
				{
					id: 2,
					mode: "ojs",
					value: "tag = (strings, ...values) => ({strings: [...strings], raw: [...strings.raw], values})",
				},
				{ id: 3, mode: "ojs", value: mode === "md" ? "md = tag" : "tex = ({block: tag})" },
				{ id: 4, mode, value, output: "report" },
			],
		},
		{ runtimeProfile: "observable" },
	);
	mounts.push(mount);
	await mount.ready();
	const result = (await mount.read("report")).data;
	expect(result).toMatchObject({ values: ["nested 3"] });
	if (mode === "md") expect(result).toMatchObject({ strings: ["Literal \\`tick\\`, \\alpha, ${literal}: ", ""] });
	else expect(result).toMatchObject({ raw: ["Literal \\`tick\\`, \\alpha, \\${literal}: ", ""] });
});

test("evaluates generator expressions inside named classic templates", async () => {
	const mount = mountNotebook(
		document.createElement("div"),
		{ cells: [{ id: 1, mode: "html", value: "<p>${yield* [1, 2]}</p>", output: "panel" }] },
		{ runtimeProfile: "observable" },
	);
	mounts.push(mount);
	await waitFor(() => (mount.state.results[0]?.values.panel === 2 ? true : undefined));
	expect((await mount.read("panel")).data).toBe(2);
});

test("retains Notebook Kit template grammar in the default profile", () => {
	const info = inspectNotebook({ cells: [{ id: 1, mode: "html", value: "<div>${viewof slider}</div>" }] });
	expect(info.cells[0]?.error).toContain("SyntaxError");
});
