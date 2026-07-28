import { describe, expect, test } from "vite-plus/test";
import {
	alertText,
	cellRecord,
	composedText,
	createHost,
	createSession,
	createView,
	graphValue,
	hasRendered,
	renderProps,
	setRange,
	variableValue,
	waitFor,
	widget,
} from "./testing";

const cells = [
	{ id: 1, mode: "ojs", value: "data = [1, 2, 3].map(i => x * i + z - y)" },
	{
		id: 2,
		mode: "ojs",
		value: `viewof x = {
  const input = document.createElement("input");
  input.type = "range";
  input.min = "0";
  input.max = "10";
  input.value = "5";
  return input;
}`,
	},
];

describe("NotebookView composition", () => {
	test("full and selected views share interactions and keep derived readback isolated", async () => {
		const session = createSession({
			_spec: { cells },
			_variables: { z: 100, y: 10 },
			_cell_keys: ["data", "x"],
		});
		const full = createView("anywidget:session", null);
		const dataView = createView("anywidget:session", [0]);
		const inputView = createView("anywidget:session", [1]);
		const host = createHost(new Map([["anywidget:session", session]]));
		const fullController = new AbortController();
		const dataController = new AbortController();
		const inputController = new AbortController();
		const fullEl = document.createElement("div");
		const dataEl = document.createElement("div");
		const inputEl = document.createElement("div");

		widget.render(renderProps(full, fullEl, fullController.signal, host));
		const fullInput = await waitFor(() => rangeWithValue(fullEl, 5));
		await waitFor(() => (variableValue(full, "data") ? true : undefined));
		widget.render(renderProps(dataView, dataEl, dataController.signal, host));
		widget.render(renderProps(inputView, inputEl, inputController.signal, host));
		const selectedInput = await waitFor(() => rangeWithValue(inputEl, 5));
		await waitFor(() => (variableValue(dataView, "data") ? true : undefined));
		expect(session.get("_view_values")).toEqual({});

		setRange(fullInput, 8);

		expect(await waitFor(() => (session.get("_view_values")?.x === 8 ? 8 : undefined))).toBe(8);
		expect(session.saveCount()).toBe(1);
		expect(await waitFor(() => rangeWithValue(inputEl, 8))).toBe(selectedInput);
		expect(await waitFor(() => sameArray(variableValue(full, "data"), [98, 106, 114]))).toBe(true);
		expect(await waitFor(() => sameArray(variableValue(dataView, "data"), [98, 106, 114]))).toBe(true);
		expect(variableValue(inputView, "x")).toBe(8);

		setRange(selectedInput, 3);

		expect(await waitFor(() => rangeWithValue(fullEl, 3))).toBe(fullInput);
		expect(await waitFor(() => sameArray(variableValue(full, "data"), [93, 96, 99]))).toBe(true);
		expect(await waitFor(() => sameArray(variableValue(dataView, "data"), [93, 96, 99]))).toBe(true);
		expect(cellRecord(full, 0)?.rendered).toBe(true);
		expect(cellRecord(full, 1)?.rendered).toBe(true);
		expect(cellRecord(dataView, 0)?.rendered).toBe(true);
		expect(cellRecord(dataView, 1)).toBeUndefined();
		expect(cellRecord(inputView, 0)).toBeUndefined();
		expect(cellRecord(inputView, 1)?.values.x).toBe(3);
		expect(session.get("_readback")).toBeUndefined();
		expect(session.saveCount()).toBe(2);

		const savesBeforeExternalUpdate = session.saveCount();
		session.set("_view_values", { x: 6 });
		expect(await waitFor(() => rangeWithValue(fullEl, 6))).toBe(fullInput);
		expect(await waitFor(() => rangeWithValue(inputEl, 6))).toBe(selectedInput);
		expect(await waitFor(() => sameArray(variableValue(dataView, "data"), [96, 102, 108]))).toBe(true);
		expect(session.saveCount()).toBe(savesBeforeExternalUpdate);

		fullController.abort();
		dataController.abort();
		inputController.abort();
	});

	test("capture-disabled views preserve rendering and shared input reactivity", async () => {
		const session = createSession({
			_spec: {
				cells: [
					{
						id: 1,
						mode: "ojs",
						value: `viewof gain = {
  const input = document.createElement("input");
  input.type = "range";
  input.value = "3";
  return input;
}`,
					},
					{ id: 2, mode: "ojs", value: "scaled = gain * base", output: "scaled" },
				],
			},
			_variables: { base: 2 },
			_cell_keys: ["gain", "scaled"],
		});
		const captured = createView("anywidget:session", null);
		const uncaptured = createView("anywidget:session", null);
		uncaptured.set("_capture_state", false);
		const host = createHost(new Map([["anywidget:session", session]]));
		const capturedController = new AbortController();
		const uncapturedController = new AbortController();
		const capturedEl = document.createElement("div");
		const uncapturedEl = document.createElement("div");

		try {
			widget.render(renderProps(captured, capturedEl, capturedController.signal, host));
			widget.render(renderProps(uncaptured, uncapturedEl, uncapturedController.signal, host));
			const capturedInput = await waitFor(() => rangeWithValue(capturedEl, 3));
			const uncapturedInput = await waitFor(() => rangeWithValue(uncapturedEl, 3));
			expect(await waitFor(() => composedText(capturedEl, "6"))).toBeInstanceOf(HTMLElement);
			expect(await waitFor(() => composedText(uncapturedEl, "6"))).toBeInstanceOf(HTMLElement);
			expect(uncapturedEl.textContent).toBe(capturedEl.textContent);

			setRange(uncapturedInput, 4);

			expect(await waitFor(() => (session.get("_view_values")?.gain === 4 ? 4 : undefined))).toBe(4);
			expect(await waitFor(() => rangeWithValue(capturedEl, 4))).toBe(capturedInput);
			expect(await waitFor(() => composedText(capturedEl, "8"))).toBeInstanceOf(HTMLElement);
			expect(await waitFor(() => composedText(uncapturedEl, "8"))).toBeInstanceOf(HTMLElement);

			session.set("_variable_update", { seq: 1, kind: "set", values: { base: 3 } });
			session.set("_variables", { base: 3 });

			expect(await waitFor(() => composedText(capturedEl, "12"))).toBeInstanceOf(HTMLElement);
			expect(await waitFor(() => composedText(uncapturedEl, "12"))).toBeInstanceOf(HTMLElement);
			expect(uncaptured.saveCount()).toBe(0);
			expect(uncaptured.savedReadbacks()).toEqual([]);
		} finally {
			capturedController.abort();
			uncapturedController.abort();
		}
	});

	test("capture-disabled selected views render through hidden dependencies", async () => {
		const session = createSession({
			_spec: {
				cells: [
					{ id: 1, mode: "ojs", value: "source = 21" },
					{ id: 2, mode: "ojs", value: "result = source * 2", output: "result" },
				],
			},
			_cell_keys: ["source", "result"],
		});
		const view = createView("anywidget:session", [1]);
		view.set("_capture_state", false);
		const host = createHost(new Map([["anywidget:session", session]]));
		const controller = new AbortController();
		const el = document.createElement("div");

		try {
			widget.render(renderProps(view, el, controller.signal, host));
			expect(await waitFor(() => composedText(el, "42"))).toBeInstanceOf(HTMLElement);
			expect(view.saveCount()).toBe(0);
			expect(view.savedReadbacks()).toEqual([]);
		} finally {
			controller.abort();
		}
	});

	test("full and data views keep their shared input stable across Python updates", async () => {
		const session = createSession({
			_spec: { cells },
			_variables: { z: 100, y: 10 },
			_cell_keys: ["data", "x"],
		});
		const full = createView("anywidget:session", null);
		const dataView = createView("anywidget:session", [0]);
		const host = createHost(new Map([["anywidget:session", session]]));
		const fullController = new AbortController();
		const dataController = new AbortController();
		const fullEl = document.createElement("div");
		const dataEl = document.createElement("div");

		widget.render(renderProps(full, fullEl, fullController.signal, host));
		widget.render(renderProps(dataView, dataEl, dataController.signal, host));
		const fullInput = await waitFor(() => rangeWithValue(fullEl, 5));
		const dependencyInput = await waitFor(() => rangeWithValue(dataEl, 5));

		setRange(fullInput, 8);

		expect(await waitFor(() => rangeWithValue(dataEl, 8))).toBe(dependencyInput);
		expect(await waitFor(() => sameArray(variableValue(full, "data"), [98, 106, 114]))).toBe(true);
		expect(await waitFor(() => sameArray(variableValue(dataView, "data"), [98, 106, 114]))).toBe(true);
		expect(session.get("_view_values")).toEqual({ x: 8 });
		const interactionSaves = session.saveCount();

		session.set("_variable_update", { seq: 1, kind: "set", values: { z: 200 } });
		session.set("_variables", { z: 200, y: 10 });

		expect(await waitFor(() => sameArray(variableValue(full, "data"), [198, 206, 214]))).toBe(true);
		expect(await waitFor(() => sameArray(variableValue(dataView, "data"), [198, 206, 214]))).toBe(true);
		expect(rangeWithValue(fullEl, 8)).toBe(fullInput);
		expect(rangeWithValue(dataEl, 8)).toBe(dependencyInput);
		expect(session.get("_view_values")).toEqual({ x: 8 });
		expect(session.saveCount()).toBe(interactionSaves);

		fullController.abort();
		dataController.abort();
	});

	test("shares real interactions after an initial Python view value and seeds fresh views", async () => {
		const session = createSession({
			_spec: { cells },
			_variables: { x: 7, z: 100, y: 10 },
		});
		const first = createView("anywidget:session", [1]);
		const second = createView("anywidget:session", [1]);
		const host = createHost(new Map([["anywidget:session", session]]));
		const firstController = new AbortController();
		const secondController = new AbortController();
		const firstEl = document.createElement("div");
		const secondEl = document.createElement("div");
		widget.render(renderProps(first, firstEl, firstController.signal, host));
		widget.render(renderProps(second, secondEl, secondController.signal, host));
		const firstInput = await waitFor(() => rangeWithValue(firstEl, 7));
		const secondInput = await waitFor(() => rangeWithValue(secondEl, 7));
		expect(session.get("_view_values")).toEqual({});

		setRange(firstInput, 8);
		expect(await waitFor(() => rangeWithValue(secondEl, 8))).toBe(secondInput);
		expect(await waitFor(() => (session.get("_view_values")?.x === 8 ? 8 : undefined))).toBe(8);

		const fresh = createView("anywidget:session", [1]);
		const freshController = new AbortController();
		const freshEl = document.createElement("div");
		widget.render(renderProps(fresh, freshEl, freshController.signal, host));
		expect(await waitFor(() => rangeWithValue(freshEl, 8))).toBeInstanceOf(HTMLInputElement);
		expect(await waitFor(() => (variableValue(fresh, "x") === 8 ? 8 : undefined))).toBe(8);

		session.set("_variable_update", { seq: 1, kind: "set", values: { x: 4 } });
		session.set("_variables", { x: 4, z: 100, y: 10 });
		expect(await waitFor(() => rangeWithValue(firstEl, 4))).toBe(firstInput);
		expect(await waitFor(() => rangeWithValue(secondEl, 4))).toBe(secondInput);
		expect(await waitFor(() => rangeWithValue(freshEl, 4))).toBeInstanceOf(HTMLInputElement);
		expect(session.get("_view_values")).toEqual({});

		firstController.abort();
		secondController.abort();
		freshController.abort();
	});

	test("reasserts the configured Python view value after a shared interaction", async () => {
		const session = createSession({
			_spec: { cells },
			_variables: { x: 7, z: 100, y: 10 },
		});
		const first = createView("anywidget:session", [1]);
		const second = createView("anywidget:session", [1]);
		const host = createHost(new Map([["anywidget:session", session]]));
		const firstController = new AbortController();
		const secondController = new AbortController();
		const firstEl = document.createElement("div");
		const secondEl = document.createElement("div");
		widget.render(renderProps(first, firstEl, firstController.signal, host));
		widget.render(renderProps(second, secondEl, secondController.signal, host));
		const firstInput = await waitFor(() => rangeWithValue(firstEl, 7));
		const secondInput = await waitFor(() => rangeWithValue(secondEl, 7));

		setRange(firstInput, 8);
		expect(await waitFor(() => rangeWithValue(secondEl, 8))).toBe(secondInput);
		expect(await waitFor(() => (session.get("_view_values")?.x === 8 ? 8 : undefined))).toBe(8);

		session.set("_variable_update", { seq: 1, kind: "set", values: { x: 7 } });
		expect(await waitFor(() => rangeWithValue(firstEl, 7))).toBe(firstInput);
		expect(await waitFor(() => rangeWithValue(secondEl, 7))).toBe(secondInput);
		expect(session.get("_view_values")).toEqual({});

		firstController.abort();
		secondController.abort();
	});

	test("canonicalizes selected cells to notebook order", async () => {
		const session = createSession({
			_spec: {
				cells: [
					{ id: 1, mode: "ojs", value: "a = 1" },
					{ id: 2, mode: "ojs", value: "b = 2" },
					{ id: 3, mode: "ojs", value: "c = 3" },
				],
			},
		});
		const view = createView("anywidget:session", [2, 0]);
		const controller = new AbortController();
		const el = document.createElement("div");
		widget.render(renderProps(view, el, controller.signal, createHost(new Map([["anywidget:session", session]]))));
		await waitFor(() => (hasRendered(view) ? true : undefined));

		const root = el.firstElementChild;
		expect(root).toBeInstanceOf(HTMLElement);
		const visible = Array.from(root?.children ?? []).filter(
			(item): item is HTMLElement => item instanceof HTMLElement && !item.hidden,
		);
		expect(visible.map((item) => item.textContent?.trim())).toEqual(["1", "3"]);
		expect(cellRecord(view, 0)?.values.a).toBe(1);
		expect(cellRecord(view, 1)).toBeUndefined();
		expect(cellRecord(view, 2)?.values.c).toBe(3);
		controller.abort();
	});

	test("scopes graph metadata to selected cells and their dependencies", async () => {
		const session = createSession({
			_spec: {
				cells: [
					{ id: 11, mode: "ojs", value: "base = 2" },
					{ id: 22, mode: "ojs", value: "selected = base * 3" },
					{ id: 33, mode: "ojs", value: "unrelated = 99" },
				],
			},
		});
		const view = createView("anywidget:session", [1]);
		const controller = new AbortController();
		const el = document.createElement("div");
		widget.render(renderProps(view, el, controller.signal, createHost(new Map([["anywidget:session", session]]))));
		await waitFor(() => (hasRendered(view) ? true : undefined));

		const graph = await waitFor(() => graphValue(view));
		expect(graph.cells.map(({ id, index }) => ({ id, index }))).toEqual([
			{ id: 11, index: 0 },
			{ id: 22, index: 1 },
		]);
		expect(graph.edges).toEqual([{ from: 11, to: 22, variable: "base" }]);
		expect(cellRecord(view, 0)).toBeUndefined();
		expect(cellRecord(view, 1)?.values.selected).toBe(6);
		expect(cellRecord(view, 2)).toBeUndefined();
		controller.abort();
	});

	test("rejects a second live mount and permits a sequential remount", async () => {
		const session = createSession({
			_spec: { cells: [{ id: 1, mode: "ojs", value: "answer = 42" }] },
		});
		const view = createView();
		const host = createHost(new Map([["anywidget:session", session]]));
		const firstController = new AbortController();
		const secondController = new AbortController();
		const firstEl = document.createElement("div");
		const secondEl = document.createElement("div");
		widget.render(renderProps(view, firstEl, firstController.signal, host));
		await waitFor(() => composedText(firstEl, "42"));
		const firstRevision = view.savedReadbacks().at(-1)!.revision;

		widget.render(renderProps(view, secondEl, secondController.signal, host));
		expect(await waitFor(() => alertText(secondEl))).toBe("Error: NotebookView already has a live writable render");

		firstController.abort();
		const thirdController = new AbortController();
		const thirdEl = document.createElement("div");
		widget.render(renderProps(view, thirdEl, thirdController.signal, host));
		expect(await waitFor(() => composedText(thirdEl, "42"))).toBeInstanceOf(HTMLElement);
		const snapshots = view.savedReadbacks();
		expect(snapshots.at(-1)!.revision).toBeGreaterThan(firstRevision);
		expect(
			snapshots.every((snapshot, index) => index === 0 || snapshot.revision > snapshots[index - 1]!.revision),
		).toBe(true);
		secondController.abort();
		thirdController.abort();
	});

	test("clears derived state before a delayed sequential remount", async () => {
		const session = createSession({
			_spec: { cells: [{ id: 1, mode: "ojs", value: "answer = 42" }] },
			_cell_keys: ["answer"],
		});
		const view = createView();
		const firstController = new AbortController();
		widget.render(
			renderProps(
				view,
				document.createElement("div"),
				firstController.signal,
				createHost(new Map([["anywidget:session", session]])),
			),
		);
		expect(await waitFor(() => (variableValue(view, "answer") === 42 ? 42 : undefined))).toBe(42);
		firstController.abort();

		session.set("_spec", { cells: [{ id: 2, mode: "ojs", value: "total = 7" }] });
		session.set("_cell_keys", ["total"]);
		let resolveSession!: (value: typeof session) => void;
		const delayedSession = new Promise<typeof session>((resolve) => {
			resolveSession = resolve;
		});
		const secondController = new AbortController();
		widget.render(
			renderProps(
				view,
				document.createElement("div"),
				secondController.signal,
				createHost(new Map([["anywidget:session", delayedSession]])),
			),
		);

		expect(hasRendered(view)).toBe(false);
		expect(cellRecord(view, 0)).toMatchObject({ status: "pending", values: {}, errors: [] });
		expect(graphValue(view)).toBeUndefined();

		resolveSession(session);
		expect(await waitFor(() => (variableValue(view, "total") === 7 ? 7 : undefined))).toBe(7);
		expect((await waitFor(() => graphValue(view))).cells[0]?.key).toBe("total");
		secondController.abort();
	});
});

function rangeWithValue(el: HTMLElement, value: number): HTMLInputElement | undefined {
	return Array.from(el.querySelectorAll<HTMLInputElement>("input[type='range']")).find(
		(input) => input.valueAsNumber === value,
	);
}

function sameArray(value: unknown, expected: number[]): true | undefined {
	return Array.isArray(value) && value.length === expected.length && value.every((item, i) => item === expected[i])
		? true
		: undefined;
}
