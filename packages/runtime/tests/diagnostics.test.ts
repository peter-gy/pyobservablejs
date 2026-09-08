import { afterEach, expect, test, vi } from "vite-plus/test";
import { DiagnosticError, mountNotebook, type MountedNotebook } from "../src";
import { waitFor } from "./testing";
import { createRuntimeViewSync } from "../src/view-inputs";

const mounts: MountedNotebook[] = [];
afterEach(() => {
	for (const mount of mounts.splice(0)) mount.dispose();
	vi.restoreAllMocks();
});
function mount(source: string, options: Parameters<typeof mountNotebook>[2] = {}) {
	const result = mountNotebook(
		document.createElement("div"),
		{ cells: [{ id: 42, mode: "ojs", value: source }] },
		{ keys: ["result"], ...options },
	);
	mounts.push(result);
	return result;
}

test("publishes authored errors with source, stack and nested cause while capture is disabled", async () => {
	vi.spyOn(console, "error").mockImplementation(() => {});
	const onDiagnostics = vi.fn();
	const source = 'result = {throw new Error("query failed", {cause: new TypeError("bad column")});}';
	const notebook = mount(source, { captureState: false, onDiagnostics });
	await expect(notebook.read("result")).rejects.toBeInstanceOf(DiagnosticError);
	await waitFor(() => (onDiagnostics.mock.calls.length ? true : undefined));
	const error = notebook.diagnostics[0];
	expect(error).toMatchObject({
		name: "Error",
		message: "query failed",
		origin: "notebook",
		phase: "evaluation",
		cause: { name: "TypeError", message: "bad column" },
		cell: { index: 0, id: 42, key: "result", mode: "ojs", source },
	});
	expect(error?.stack).toContain("query failed");
	expect(Object.isFrozen(error)).toBe(true);
	expect(Object.isFrozen(error?.cell)).toBe(true);
	expect(notebook.state.inputRevision).toBeNull();
});

test("ready rejects current authored errors and follows input recovery", async () => {
	vi.spyOn(console, "error").mockImplementation(() => {});
	const notebook = mount('result = {if (fail) throw new Error("try again"); return 7;}', { variables: { fail: true } });
	await expect(notebook.ready()).rejects.toMatchObject({ diagnostic: { origin: "notebook", message: "try again" } });
	notebook.updateVariables({ fail: false });
	expect(notebook.diagnostics).toEqual([]);
	expect((await notebook.ready()).results[0]?.values.result).toBe(7);
});

test("input setter failures reject readiness and reads and can recover", async () => {
	const control = new EventTarget();
	let value = 1;
	let fail = true;
	Object.defineProperty(control, "value", {
		get: () => value,
		set: (next: number) => {
			if (fail) throw new TypeError("control setter failed");
			value = next;
		},
	});
	const notebook = mount("viewof result = control", { variables: { control } });
	await notebook.ready();
	notebook.updateVariables({ result: Promise.resolve(2) });
	await expect(notebook.ready()).rejects.toMatchObject({
		diagnostic: {
			origin: "runtime",
			component: "packages/runtime/src/inputs.ts",
			operation: "write input",
			name: "TypeError",
			message: "control setter failed",
		},
	});
	await expect(notebook.read("result")).rejects.toBeInstanceOf(DiagnosticError);
	fail = false;
	notebook.updateVariables({ result: 3 });
	await notebook.ready();
	expect((await notebook.read("result")).data).toBe(3);
});

test("dataset callback failures remain visible while authored values stay readable", async () => {
	const notebook = mount("result = [{x: 1}]", {
		onDatasets() {
			throw new Error("dataset callback failed");
		},
	});
	await expect(notebook.ready()).rejects.toMatchObject({
		diagnostic: { origin: "runtime", operation: "onDatasets", message: "dataset callback failed" },
	});
	expect((await notebook.read("result", { format: "rows" })).data).toEqual([{ x: 1 }]);
});

test("ready supports cancellation and requires captured evaluation state", async () => {
	const notebook = mount("result = new Promise(() => {})");
	const controller = new AbortController();
	const ready = notebook.ready({ signal: controller.signal });
	controller.abort();
	await expect(ready).rejects.toMatchObject({ name: "AbortError" });
	const disposed = notebook.ready();
	notebook.dispose();
	await expect(disposed).rejects.toMatchObject({ name: "AbortError" });
	await expect(mount("result = 1", { captureState: false }).ready()).rejects.toThrow("captureState");
});

test("reports syntax failures before readiness and read completion", async () => {
	const notebook = mount("result = (");
	await expect(notebook.ready()).rejects.toMatchObject({
		diagnostic: { origin: "notebook", phase: "analysis", cell: { key: "result" } },
	});
	expect(notebook.diagnostics[0]?.name).toBe("SyntaxError");
});

test("isolates state and diagnostic callback failures", async () => {
	const state = mount("result = 1", {
		onState() {
			throw new Error("state callback failed");
		},
	});
	await expect(state.ready()).rejects.toMatchObject({ diagnostic: { origin: "runtime", operation: "onState" } });
	expect((await state.read("result")).data).toBe(1);
	vi.spyOn(console, "error").mockImplementation(() => {});
	const onDiagnostics = vi.fn(() => {
		throw new Error("diagnostic callback failed");
	});
	const diagnostic = mount('result = {throw new Error("authored");}', { onDiagnostics });
	await waitFor(() =>
		diagnostic.diagnostics.some((error) => error.operation === "publish diagnostics") ? true : undefined,
	);
	expect(onDiagnostics).toHaveBeenCalledTimes(1);
	expect(diagnostic.diagnostics).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ origin: "notebook", message: "authored" }),
			expect.objectContaining({ origin: "runtime", message: "diagnostic callback failed" }),
		]),
	);
});

test("releases later controls when an earlier control throws during cleanup", () => {
	const controller = new AbortController();
	const errors = vi.fn();
	const sync = createRuntimeViewSync({
		variables: { setView() {}, deleteView() {}, applyInitialViews() {} },
		initialValues: {},
		signal: controller.signal,
		onChange() {},
		onInput() {},
		onError: errors,
	});
	const broken = new EventTarget();
	Object.assign(broken, {
		value: 1,
		removeEventListener() {
			throw new Error("remove listener failed");
		},
	});
	const healthy = new EventTarget();
	Object.assign(healthy, { value: 2 });
	const listeners = new Set<EventListenerOrEventListenerObject | null>();
	const add = healthy.addEventListener.bind(healthy);
	const remove = healthy.removeEventListener.bind(healthy);
	healthy.addEventListener = (type, listener, options) => {
		listeners.add(listener);
		add(type, listener, options);
	};
	healthy.removeEventListener = (type, listener, options) => {
		listeners.delete(listener);
		remove(type, listener, options);
	};
	sync.register("first", broken);
	sync.register("second", healthy);
	expect(listeners.size).toBeGreaterThan(0);
	controller.abort();
	expect(listeners.size).toBe(0);
	expect(errors).toHaveBeenCalledWith(
		"first",
		expect.objectContaining({ message: "remove listener failed" }),
		"dispose input",
	);
});

test("reports revoked proxies thrown by anonymous cells", async () => {
	vi.spyOn(console, "error").mockImplementation(() => {});
	const notebook = mount("{const {proxy, revoke} = Proxy.revocable({}, {}); revoke(); throw proxy;}");
	await expect(notebook.read({ cell: 0 })).rejects.toMatchObject({
		diagnostic: { origin: "notebook", message: "A non-Error value was thrown", cell: { index: 0 } },
	});
	expect(notebook.diagnostics).toEqual(
		expect.arrayContaining([expect.objectContaining({ origin: "notebook", message: "A non-Error value was thrown" })]),
	);
});

test("retains cleanup failures raised while replacing a runtime", async () => {
	const control = new EventTarget();
	Object.assign(control, { value: 1 });
	const remove = control.removeEventListener.bind(control);
	control.removeEventListener = (type, listener, options) => {
		if (type === "change") throw new Error("control cleanup failed");
		remove(type, listener, options);
	};
	const notebook = mount("viewof result = control", { variables: { control } });
	await notebook.ready();
	const replacement = new EventTarget();
	Object.assign(replacement, { value: 2 });
	notebook.replaceVariables({ control: replacement });
	await expect(notebook.ready()).rejects.toMatchObject({
		diagnostic: { origin: "runtime", operation: "dispose input", message: "control cleanup failed" },
	});
});
