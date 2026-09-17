import { afterEach, expect, test } from "vite-plus/test";
import { mountNotebook, type MountOptions } from "../src";
import { evaluateNotebook } from "../src/headless-api";
import type { NotebookSpec } from "@observablehq/notebook-kit";

const notebooks: { dispose(): void }[] = [];
afterEach(() => {
	for (const notebook of notebooks.splice(0)) notebook.dispose();
});

const hosts = {
	browser: (source: NotebookSpec, options: MountOptions) =>
		mountNotebook(document.createElement("div"), source, options),
	headless: evaluateNotebook,
};

for (const [name, create] of Object.entries(hosts)) {
	test(`${name} keeps native reads, diagnostics, and ownership coherent across updates`, async () => {
		const notebook = create(
			{
				cells: [
					{ id: 1, mode: "ojs", value: "x = 1" },
					{ id: 2, mode: "ojs", value: "rows = [{x}]" },
					{ id: 3, mode: "ojs", value: 'result = { if (x < 0) throw new Error("negative"); return x * 2; }' },
					{ id: 4, mode: "ojs", value: "[x]" },
					{ id: 5, mode: "ojs", value: 'viewof amount = Object.assign(document.createElement("input"), {value: "5"})' },
					{ id: 6, mode: "ojs", value: "chosen = +amount" },
				],
			},
			{ keys: ["x", "rows", "result", "anonymous", "amount", "chosen"] },
		);
		notebooks.push(notebook);
		const ready = () => notebook.ready({ signal: AbortSignal.timeout(2000) });
		await ready();
		expect((await notebook.read({ cell: 3 })).data).toEqual([1]);
		expect(notebook.state.results[3]?.values).toEqual({ anonymous: [1] });
		notebook.updateVariables({ x: -1, amount: 9 });
		await expect(ready()).rejects.toThrow("negative");
		expect((await notebook.read("rows")).data).toEqual([{ x: -1 }]);
		expect((await notebook.read("chosen")).data).toBe(9);
		expect(notebook.diagnostics).toEqual([
			expect.objectContaining({
				origin: "notebook",
				phase: "evaluation",
				message: "negative",
				cell: expect.objectContaining({ key: "result", index: 2 }),
			}),
		]);
		notebook.updateVariables({ x: 4 });
		await ready();
		expect(notebook.diagnostics).toEqual([]);
		expect((await notebook.read("result")).data).toBe(8);
		notebook.replaceVariables({});
		await ready();
		expect((await notebook.read("result")).data).toBe(2);
		expect((await notebook.read("chosen")).data).toBe(5);
	});

	test(`${name} cancels pending reads and ignores late values after disposal`, async () => {
		let resolve!: (value: number[]) => void;
		const deferred = new Promise<number[]>((done) => {
			resolve = done;
		});
		const notebook = create({ cells: [{ id: 1, mode: "ojs", value: "rows = deferred" }] }, { variables: { deferred } });
		notebooks.push(notebook);
		const read = notebook.read("rows");
		const ready = notebook.ready();
		notebook.dispose();
		resolve([1]);
		await expect(read).rejects.toThrow();
		await expect(ready).rejects.toThrow();
		expect(notebook.datasets).toEqual([]);
		await expect(notebook.read("rows")).rejects.toThrow();
		await expect(notebook.ready()).rejects.toThrow();
	});
}

test("headless variable ownership changes close failed replacement attempts", async () => {
	let unavailable = false;
	const notebook = evaluateNotebook(
		{
			cells: [
				{ id: 1, mode: "ojs", value: 'viewof amount = Object.assign(document.createElement("input"), {value: "5"})' },
			],
		},
		{
			get attachments() {
				if (unavailable) throw new Error("Attachment registry unavailable");
				return {};
			},
		},
	);
	notebooks.push(notebook);
	await notebook.ready({ signal: AbortSignal.timeout(2000) });
	unavailable = true;
	expect(() => notebook.updateVariables({ amount: 9 })).toThrow("Attachment registry unavailable");
	await expect(notebook.ready()).rejects.toThrow("closed");
	await expect(notebook.read("amount")).rejects.toThrow("closed");
	expect(notebook.datasets).toEqual([]);
});
