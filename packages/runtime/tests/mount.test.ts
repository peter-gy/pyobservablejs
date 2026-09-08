import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { mountNotebook, type MountedNotebook } from "../src";
import { waitFor } from "./testing";

const mounts = new Set<MountedNotebook>();
afterEach(() => {
	for (const mount of mounts) mount.dispose();
	mounts.clear();
});

function track(mount: MountedNotebook): MountedNotebook {
	mounts.add(mount);
	return mount;
}

async function settled(mount: MountedNotebook): Promise<void> {
	await waitFor(() => (mount.state.inputRevision !== null && !mount.state.pending ? true : undefined));
}

describe("native notebook mounting", () => {
	test("shares unchanged immutable cell results across evaluation snapshots", async () => {
		const mount = track(
			mountNotebook(
				document.createElement("div"),
				{
					cells: [
						{ id: 1, mode: "ojs", value: "left = gain + 1" },
						{ id: 2, mode: "ojs", value: "right = 4" },
					],
				},
				{ variables: { gain: 1 } },
			),
		);
		await settled(mount);
		const before = mount.state;
		mount.updateVariables({ gain: 7 });
		await settled(mount);
		expect(mount.state.results[0]?.values.left).toBe(8);
		expect(before.results[0]?.values.left).toBe(2);
		expect(mount.state.results[1]).toBe(before.results[1]);
		expect(Object.isFrozen(mount.state.results[1])).toBe(true);
		expect(Object.isFrozen(before.results)).toBe(true);
	});
	test.each(["md", "html"] as const)("renders %s templates with asynchronous dependencies", async (mode) => {
		const tag = (_strings: TemplateStringsArray, gain: number) => {
			const node = document.createElement("span");
			node.textContent = `Gain ${gain}`;
			return node;
		};
		const el = document.createElement("div");
		const mount = track(
			mountNotebook(
				el,
				{
					cells: [
						{ id: 1, mode: "ojs", value: mode === "md" ? "md = tag" : "htl = ({html: tag})" },
						{ id: 2, mode, value: "${gain}" },
					],
				},
				{ variables: { tag: Promise.resolve(tag), gain: Promise.resolve(2) } },
			),
		);
		await settled(mount);
		expect(el.textContent).toContain("Gain 2");
	});

	test.each(["md", "html"] as const)("invalidates %s template resources on updates and disposal", async (mode) => {
		const cleanup = vi.fn();
		const tag = (_strings: TemplateStringsArray, gain: number) => {
			const node = document.createElement("span");
			node.textContent = `Gain ${gain}`;
			return node;
		};
		const el = document.createElement("div");
		const mount = track(
			mountNotebook(
				el,
				{
					cells: [
						{ id: 1, mode: "ojs", value: mode === "md" ? "md = tag" : "htl = ({html: tag})" },
						{ id: 2, mode, value: "${(invalidation.then(() => cleanup(gain)), gain)}" },
					],
				},
				{ variables: { tag, gain: 2, cleanup } },
			),
		);
		await settled(mount);
		expect(el.textContent).toContain("Gain 2");
		expect(cleanup).not.toHaveBeenCalled();
		mount.updateVariables({ gain: 7 });
		await waitFor(() => (el.textContent?.includes("Gain 7") && !mount.state.pending ? true : undefined));
		expect(cleanup).toHaveBeenCalledExactlyOnceWith(2);
		mount.dispose();
		await waitFor(() => (cleanup.mock.calls.length === 2 ? true : undefined));
		expect(cleanup.mock.calls).toEqual([[2], [7]]);
	});

	test("passes the previous Observable cell value as its receiver during recomputation", async () => {
		const mount = track(
			mountNotebook(
				document.createElement("div"),
				{
					cells: [{ id: 1, mode: "ojs", value: "count = gain + (this ?? 0)" }],
				},
				{ variables: { gain: 1 } },
			),
		);
		expect((await mount.read("count")).data).toBe(1);
		mount.updateVariables({ gain: 2 });
		expect((await mount.read("count")).data).toBe(3);
	});

	test("captures native values with detached state containers and preserved value identity", async () => {
		const node = document.createElement("span");
		node.textContent = "native node";
		const fn = (value: number) => value * 3;
		const cyclic = {
			name: "cyclic",
			get self() {
				return this;
			},
		};
		const mount = track(
			mountNotebook(
				document.createElement("div"),
				{ cells: [{ id: 1, mode: "ojs", value: "result = ({node,fn,cyclic,missing})" }] },
				{ variables: { node, fn, cyclic, missing: undefined } },
			),
		);
		await settled(mount);
		expect(mount.state.results[0]?.status).toBe("success");
		expect(mount.state.results[0]?.values.result).toEqual({ node, fn, cyclic, missing: undefined });
		const result = mount.state.results[0]?.values.result;
		expect(result).toHaveProperty("node", node);
		expect(Object.isFrozen(mount.state)).toBe(true);
		expect(Object.isFrozen(mount.state.results[0]?.values)).toBe(true);
		expect(Object.isFrozen(node)).toBe(false);
	});

	test("renders selected cells with their hidden dependency closure and restores authored variables", async () => {
		const el = document.createElement("div");
		const mount = track(
			mountNotebook(
				el,
				{
					cells: [
						{ id: 1, mode: "ojs", value: "x = 2" },
						{ id: 2, mode: "ojs", value: "answer = x * 3" },
						{ id: 3, mode: "ojs", value: "unrelated = 99" },
					],
				},
				{ selection: [1], keys: ["x", "answer", "unrelated"], variables: { x: 4 } },
			),
		);
		await settled(mount);
		expect(mount.state.results[1]?.values.answer).toBe(12);
		expect(Object.keys(mount.state.results)).toEqual(["1"]);
		expect(mount.state.graph?.cells.map((cell) => cell.key)).toEqual(["x", "answer"]);
		expect(el.querySelectorAll("[hidden]")).toHaveLength(1);
		const initial = mount.state;
		mount.updateVariables({ x: 5 });
		await waitFor(() => (mount.state.results[1]?.values.answer === 15 && !mount.state.pending ? true : undefined));
		expect(initial.results[1]?.values.answer).toBe(12);
		mount.replaceVariables({});
		await waitFor(() => (mount.state.results[1]?.values.answer === 6 && !mount.state.pending ? true : undefined));
		expect(mount.state.inputRevision).toBeGreaterThan(initial.inputRevision ?? -1);
	});

	test("replays inputs before publication and reports browser interactions once", async () => {
		const el = document.createElement("div");
		const onInput = vi.fn();
		const mount = track(
			mountNotebook(
				el,
				{
					cells: [
						{
							id: 1,
							mode: "ojs",
							value:
								'viewof x = {const input = document.createElement("input"); input.type="number"; input.value="2"; return input;}',
						},
						{ id: 2, mode: "ojs", value: "answer = x * 3" },
					],
				},
				{ variables: { x: 4 }, inputs: { x: 5 }, onInput },
			),
		);
		await settled(mount);
		expect(mount.state.results[1]?.values.answer).toBe(15);
		expect(onInput).not.toHaveBeenCalled();
		mount.setInputs({ x: 6 });
		await waitFor(() => (mount.state.results[1]?.values.answer === 18 && !mount.state.pending ? true : undefined));
		expect(onInput).not.toHaveBeenCalled();
		const input = el.querySelector("input");
		if (!input) throw new Error("Notebook input did not render");
		input.value = "7";
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.dispatchEvent(new Event("change", { bubbles: true }));
		await waitFor(() => (mount.state.results[1]?.values.answer === 21 && !mount.state.pending ? true : undefined));
		expect(onInput).toHaveBeenCalledExactlyOnceWith("x", 7);
		mount.updateVariables({ x: 8 });
		await waitFor(() => (mount.state.results[1]?.values.answer === 24 && !mount.state.pending ? true : undefined));
		expect(onInput).toHaveBeenCalledTimes(1);
		mount.dispose();
		input.value = "9";
		input.dispatchEvent(new Event("input", { bubbles: true }));
		expect(onInput).toHaveBeenCalledTimes(1);
		expect(el.childNodes).toHaveLength(0);
	});

	test("releases notebook resources on host cancellation and rejects later writes", async () => {
		const invalidated = vi.fn();
		const controller = new AbortController();
		const el = document.createElement("div");
		const mount = track(
			mountNotebook(
				el,
				{ cells: [{ id: 1, mode: "ojs", value: "value = {invalidation.then(invalidated); return 1;}" }] },
				{ variables: { invalidated }, signal: controller.signal },
			),
		);
		await settled(mount);
		controller.abort();
		await waitFor(() => (invalidated.mock.calls.length === 1 ? true : undefined));
		expect(el.childNodes).toHaveLength(0);
		expect(() => mount.updateVariables({ value: 2 })).toThrow("disposed");
	});
	test("rejects stale evaluations across replacement and recovers from rejected native input", async () => {
		const waits = new Map<number, (value: number) => void>();
		const wait = (value: number) => new Promise<number>((resolve) => waits.set(value, resolve));
		const mount = track(
			mountNotebook(
				document.createElement("div"),
				{ cells: [{ id: 1, mode: "ojs", value: "answer = await wait(x)" }] },
				{ variables: { wait, x: 1 } },
			),
		);
		await waitFor(() => waits.get(1));
		mount.replaceVariables({ wait, x: 2 });
		const resolveCurrent = await waitFor(() => waits.get(2));
		waits.get(1)?.(100);
		resolveCurrent(200);
		await settled(mount);
		expect(mount.state.results[0]?.values.answer).toBe(200);
		mount.updateVariables({ x: Promise.reject(new Error("input failed")) });
		await waitFor(() => (mount.state.results[0]?.status === "error" && !mount.state.pending ? true : undefined));
		expect(mount.state.results[0]?.errors).toContainEqual(
			expect.objectContaining({ message: "input failed", phase: "evaluation", variable: "answer" }),
		);
		mount.updateVariables({ x: 3 });
		const resolveRecovery = await waitFor(() => waits.get(3));
		resolveRecovery(300);
		await settled(mount);
		expect(mount.state.results[0]?.values.answer).toBe(300);
	});

	test("mounts Notebook Kit source with capture disabled", async () => {
		const onState = vi.fn();
		const el = document.createElement("div");
		const mount = track(
			mountNotebook(
				el,
				'<notebook theme="air"><script id="1" type="application/vnd.observable.javascript">answer = 42</script></notebook>',
				{ captureState: false, onState },
			),
		);
		await waitFor(() => (el.textContent?.includes("42") ? true : undefined));
		expect(mount.state).toEqual({
			inputRevision: null,
			settledRevision: null,
			pending: false,
			graph: null,
			results: {},
			errors: [],
		});
		expect(onState).not.toHaveBeenCalled();
	});

	test("owns its host until disposal and rejects aborted mounts before touching the DOM", async () => {
		const el = document.createElement("div");
		const first = track(mountNotebook(el, { cells: [{ id: 1, mode: "ojs", value: "answer = 42" }] }));
		await settled(first);
		expect(() => mountNotebook(el, { cells: [] })).toThrow("already has a live mount");
		expect(el.textContent).toContain("42");
		first.dispose();
		const second = track(mountNotebook(el, { cells: [{ id: 1, mode: "ojs", value: "answer = 99" }] }));
		await settled(second);
		first.dispose();
		expect(el.textContent).toContain("99");
		const controller = new AbortController();
		controller.abort();
		expect(() => mountNotebook(el, { cells: [] }, { signal: controller.signal })).toThrow();
		expect(el.textContent).toContain("99");
	});
	test("publishes repeated input events for an object mutated in place", async () => {
		const onInput = vi.fn();
		const control = Object.assign(new EventTarget(), { value: { count: 1 } });
		const mount = track(
			mountNotebook(
				document.createElement("div"),
				{
					cells: [
						{ id: 1, mode: "ojs", value: "viewof selection = control", hidden: true },
						{ id: 2, mode: "ojs", value: "count = selection.count" },
					],
				},
				{ variables: { control }, onInput },
			),
		);
		await settled(mount);
		control.value.count = 2;
		control.dispatchEvent(new Event("input"));
		control.dispatchEvent(new Event("change"));
		await waitFor(() => (mount.state.results[1]?.values.count === 2 && !mount.state.pending ? true : undefined));
		control.value.count = 3;
		control.dispatchEvent(new Event("input"));
		control.dispatchEvent(new Event("change"));
		await waitFor(() => (mount.state.results[1]?.values.count === 3 && !mount.state.pending ? true : undefined));
		expect(onInput).toHaveBeenCalledTimes(2);
		expect(onInput.mock.calls[1]?.[1]).toBe(control.value);
		control.value.count = 4;
		mount.setInputs({ selection: control.value });
		await waitFor(() => (mount.state.results[1]?.values.count === 4 && !mount.state.pending ? true : undefined));
		expect(onInput).toHaveBeenCalledTimes(2);
	});

	test("keeps named constants settled when replay names have no mounted input", async () => {
		const mount = track(
			mountNotebook(document.createElement("div"), {
				cells: [
					{ id: 1, mode: "ojs", value: "x = 1" },
					{ id: 2, mode: "ojs", value: "answer = x + 1" },
				],
			}),
		);
		await settled(mount);
		const initial = mount.state;
		mount.setInputs({ x: 10 });
		expect(mount.state).toBe(initial);
		expect(mount.state.results[1]?.values.answer).toBe(2);
	});
});
