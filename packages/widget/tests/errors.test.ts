import { expect, test, vi } from "vite-plus/test";
import { DiagnosticPublisher } from "../src/errors";
import { ReadbackPublisher } from "../src/readback";
import { createHost, createNotebookFixture, createView, renderProps, variableValue, widget } from "./testing";

test("publishes bootstrap failures with stacks when capture is disabled", async () => {
	const view = createView();
	view.set("_capture_state", false);
	const controller = new AbortController();
	const cause = Object.assign(new Error("session unavailable"), { cause: new TypeError("model missing") });
	const host = createHost(new Map([["anywidget:session", Promise.reject(cause)]]));
	try {
		widget.render(renderProps(view, document.createElement("div"), controller.signal, host));
		await expect
			.poll(() => view.get("_diagnostics")?.errors?.[0])
			.toMatchObject({
				name: "Error",
				message: "session unavailable",
				origin: "widget",
				component: "packages/widget/src/view.ts",
				operation: "resolve session",
				stack: expect.stringContaining("session unavailable"),
				cause: { name: "TypeError", message: "model missing" },
			});
		expect(view.get("_readback")?.input_revision).toBeNull();
	} finally {
		controller.abort();
	}
});

test("publishes invalid capture options before a runtime exists", async () => {
	const { view, host } = createNotebookFixture({ _spec: { cells: [] } });
	view.set("_capture_state", "invalid");
	const controller = new AbortController();
	const el = document.createElement("div");
	try {
		widget.render(renderProps(view, el, controller.signal, host));
		await expect
			.poll(() => view.get("_diagnostics")?.errors?.[0])
			.toMatchObject({
				origin: "widget",
				component: "packages/widget/src/model.ts",
				operation: "read view options",
				message: "NotebookView capture state must be a boolean",
			});
		expect(el.querySelector('[role="alert"]')?.textContent).toBe("Error: NotebookView capture state must be a boolean");
	} finally {
		controller.abort();
	}
});

test("reports authored errors and recovery with capture disabled", async () => {
	const { session, view, host } = createNotebookFixture({
		_spec: {
			cells: [{ id: 12, mode: "ojs", value: 'answer = fail ? (() => {throw new Error("authored failure")})() : 42' }],
		},
		_variables: { fail: true },
		_cell_keys: ["answer"],
	});
	view.set("_capture_state", false);
	const controller = new AbortController();
	try {
		widget.render(renderProps(view, document.createElement("div"), controller.signal, host));
		await expect
			.poll(() => view.get("_diagnostics")?.errors?.[0])
			.toMatchObject({
				origin: "notebook",
				phase: "evaluation",
				message: "authored failure",
				cell: { index: 0, id: 12, key: "answer", mode: "ojs", source: expect.stringContaining("authored failure") },
			});
		session.set("_variable_update", { seq: 1, kind: "set", values: { fail: false } });
		await expect.poll(() => view.get("_diagnostics")).toMatchObject({ sequence: 1, errors: [] });
		expect(view.get("_readback")?.input_revision).toBeNull();
	} finally {
		controller.abort();
	}
});

test("catches model event failures and retains them through fatal cleanup", async () => {
	const { session, view, host } = createNotebookFixture({
		_spec: { cells: [{ id: 1, mode: "ojs", value: "answer = gain" }] },
		_variables: { gain: 1 },
	});
	const controller = new AbortController();
	const el = document.createElement("div");
	try {
		widget.render(renderProps(view, el, controller.signal, host));
		await expect.poll(() => variableValue(view, "answer")).toBe(1);
		expect(() => session.set("_variable_update", { seq: 1, kind: "set", values: { document: 42 } })).not.toThrow();
		await expect
			.poll(() => view.get("_diagnostics")?.errors?.[0])
			.toMatchObject({
				origin: "widget",
				operation: "apply Python variables",
				component: "packages/widget/src/view.ts",
			});
		expect(el.querySelector('[role="alert"]')?.textContent).toContain("builtins");
		expect(view.get("_diagnostics")?.sequence).toBe(1);
	} finally {
		controller.abort();
	}
});

test("clears stale diagnostics on a new mount and rejects callbacks from the old mount", async () => {
	const model = createView();
	const controller = new AbortController();
	const publisher = new DiagnosticPublisher(model, controller.signal, document.createElement("div"));
	let sequence = 3;
	const old = publisher.start(() => sequence);
	old.report(new Error("old"), {
		phase: "rendering",
		component: "packages/widget/src/view.ts",
		operation: "mount view",
	});
	await Promise.resolve();
	const revision = model.get("_diagnostics")!.revision!;
	sequence = 4;
	publisher.start(() => sequence);
	old.report(new Error("late"), {
		phase: "rendering",
		component: "packages/widget/src/view.ts",
		operation: "mount view",
	});
	await Promise.resolve();
	expect(model.get("_diagnostics")).toMatchObject({ sequence: 4, errors: [] });
	expect(model.get("_diagnostics")!.revision).toBeGreaterThan(revision);
	controller.abort();
});

test("reports readback microtask transport failures", async () => {
	const model = createView();
	const controller = new AbortController();
	const fail = vi.fn();
	const publisher = new ReadbackPublisher(model, controller.signal, { update() {}, fail });
	vi.spyOn(model, "save_changes").mockImplementation(() => {
		throw new Error("comm failed");
	});
	publisher.start()({ inputRevision: 0, settledRevision: 0, pending: false, graph: null, results: {}, errors: [] });
	await Promise.resolve();
	expect(fail).toHaveBeenCalledWith(expect.objectContaining({ message: "comm failed" }));
	controller.abort();
});

test("acknowledges readiness after the requested Python update is applied and readback commits", async () => {
	const { session, view, host } = createNotebookFixture({
		_spec: { cells: [{ id: 1, mode: "ojs", value: "answer = gain" }] },
		_variables: { gain: 1 },
	});
	const controller = new AbortController();
	try {
		widget.render(renderProps(view, document.createElement("div"), controller.signal, host));
		await expect.poll(() => variableValue(view, "answer")).toBe(1);
		const generation = view.get("_inspection")!.generation!;
		let revisionAtResponse: number | undefined;
		const send = view.send.bind(view);
		vi.spyOn(view, "send").mockImplementation((...args) => {
			revisionAtResponse = view.get("_readback")?.revision;
			send(...args);
		});
		view.receiveCustom({
			kind: "observablejs:access",
			protocol: 1,
			type: "request",
			id: "checkpoint",
			generation,
			params: { operation: "ready", sequence: 1 },
		});
		await Promise.resolve();
		expect(view.sentMessages()).toHaveLength(0);
		session.set("_variable_update", { seq: 1, kind: "set", values: { gain: 9 } });
		await expect.poll(() => view.sentMessages().length).toBe(1);
		expect(view.sentMessages()[0]!.content).toMatchObject({
			type: "response",
			id: "checkpoint",
			result: {
				ready: true,
				readback: { revision: revisionAtResponse, pending: false },
				diagnostics: { sequence: 1, errors: [] },
			},
		});
		expect(variableValue(view, "answer")).toBe(9);
		expect(view.get("_readback")?.pending).toBe(false);
	} finally {
		controller.abort();
	}
});

test("clears browser-input serialization errors when the control produces a valid value", async () => {
	const { view, host } = createNotebookFixture({
		_spec: {
			cells: [
				{ id: 1, mode: "ojs", value: 'viewof selected = Object.assign(document.createElement("form"), {value: 0})' },
			],
		},
	});
	view.set("_capture_state", false);
	const controller = new AbortController();
	const el = document.createElement("div");
	try {
		widget.render(renderProps(view, el, controller.signal, host));
		await expect.poll(() => el.querySelector("form")).not.toBeNull();
		const form = el.querySelector("form")!;
		Object.assign(form, {
			value: new Proxy(
				{},
				{
					ownKeys() {
						throw new Error("input serialization failed");
					},
				},
			),
		});
		form.dispatchEvent(new Event("input", { bubbles: true }));
		await expect
			.poll(() => view.get("_diagnostics")?.errors?.[0])
			.toMatchObject({
				origin: "widget",
				phase: "serialization",
				component: "packages/widget/src/values.ts",
				variable: "selected",
				message: "input serialization failed",
			});
		Object.assign(form, { value: 7 });
		form.dispatchEvent(new Event("input", { bubbles: true }));
		await expect.poll(() => view.get("_diagnostics")?.errors).toEqual([]);
	} finally {
		controller.abort();
	}
});

test("carries readiness state and all diagnostics when trait delivery is delayed", async () => {
	const { session, view, host } = createNotebookFixture({
		_spec: {
			cells: [
				{ id: 1, mode: "ojs", value: 'first = fail ? (() => {throw new Error("first failed")})() : 1' },
				{ id: 2, mode: "ojs", value: 'second = fail ? (() => {throw new Error("second failed")})() : 2' },
			],
		},
		_variables: { fail: false },
	});
	const controller = new AbortController();
	try {
		widget.render(renderProps(view, document.createElement("div"), controller.signal, host));
		await expect.poll(() => variableValue(view, "second")).toBe(2);
		const delivered = view.savedReadbacks().length;
		vi.spyOn(view, "save_changes").mockImplementation(() => {});
		const generation = view.get("_inspection")!.generation!;
		const request = (id: string, sequence: number) =>
			view.receiveCustom({
				kind: "observablejs:access",
				protocol: 1,
				type: "request",
				id,
				generation,
				params: { operation: "ready", sequence },
			});
		request("failure", 1);
		session.set("_variable_update", { seq: 1, kind: "set", values: { fail: true } });
		await expect.poll(() => view.sentMessages().length).toBe(1);
		expect(view.sentMessages()[0]!.content).toMatchObject({
			id: "failure",
			error: { origin: "notebook" },
			diagnostics: {
				sequence: 1,
				errors: expect.arrayContaining([
					expect.objectContaining({ message: "first failed" }),
					expect.objectContaining({ message: "second failed" }),
				]),
			},
		});
		request("recovery", 2);
		session.set("_variable_update", { seq: 2, kind: "set", values: { fail: false } });
		await expect.poll(() => view.sentMessages().length).toBe(2);
		expect(view.sentMessages()[1]!.content).toMatchObject({
			id: "recovery",
			result: {
				ready: true,
				readback: { pending: false, results: { 0: { values: { first: 1 } }, 1: { values: { second: 2 } } } },
				diagnostics: { sequence: 2, errors: [] },
			},
		});
		expect(view.savedReadbacks()).toHaveLength(delivered);
	} finally {
		controller.abort();
	}
});
