import { describe, expect, test, vi } from "vite-plus/test";
import {
	alertText,
	cellRecord,
	composedText,
	createNotebookFixture,
	graphValue,
	hasRendered,
	renderProps,
	variableValue,
	waitFor,
	widget,
} from "./testing";

describe("widget graph and notebook readback", () => {
	test("marks an empty notebook rendered with a complete graph", async () => {
		const { view, host } = createNotebookFixture({ _spec: { cells: [] } });
		const controller = new AbortController();

		try {
			widget.render(renderProps(view, document.createElement("div"), controller.signal, host));
			expect(await waitFor(() => (hasRendered(view) ? true : undefined))).toBe(true);
			expect(graphValue(view)).toEqual({ cells: [], edges: [] });
			expect(view.savedReadbacks().at(-1)).toMatchObject({ rendered: true, cells: {} });
		} finally {
			controller.abort();
		}
	});

	test("renders one NotebookView runtime and publishes graph and cell readback on its view model", async () => {
		const { view, host } = createNotebookFixture({
			_spec: {
				cells: [
					{ id: 1, mode: "ojs", value: "answer = 42" },
					{ id: 2, mode: "ojs", value: "answer + 1" },
				],
			},
			_cell_keys: ["answer", "readout"],
		});
		const controller = new AbortController();
		const el = document.createElement("div");

		widget.render(renderProps(view, el, controller.signal, host));

		const graph = await waitFor(() => graphValue(view));
		expect(graph.cells.map((cell) => cell.key)).toEqual(["answer", "readout"]);
		expect(graph.cells[1]?.references).toEqual(["answer"]);
		expect(graph.edges).toContainEqual({ from: 1, to: 2, variable: "answer" });
		expect(await waitFor(() => (variableValue(view, "answer") === 42 ? 42 : undefined))).toBe(42);
		expect(await waitFor(() => (variableValue(view, "readout") === 43 ? 43 : undefined))).toBe(43);
		expect(await waitFor(() => (hasRendered(view) ? true : undefined))).toBe(true);
		controller.abort();
	});

	test("marks a multi-output cell and notebook rendered after every output settles", async () => {
		let resolveY!: (value: number) => void;
		let evaluationStarted = false;
		const y = new Promise<number>((resolve) => {
			resolveY = resolve;
		});
		Object.defineProperty(globalThis, "__pyobservablejsPendingY", {
			configurable: true,
			get() {
				evaluationStarted = true;
				return y;
			},
		});
		const { view, host } = createNotebookFixture({
			_spec: {
				cells: [
					{
						id: 1,
						mode: "js",
						value: "const x = 1;\nconst y = globalThis.__pyobservablejsPendingY;",
					},
				],
			},
			_cell_keys: ["metrics"],
		});
		const controller = new AbortController();
		try {
			widget.render(renderProps(view, document.createElement("div"), controller.signal, host));
			await waitFor(() => (evaluationStarted ? true : undefined));
			expect(cellRecord(view, 0)).toBeUndefined();
			expect(hasRendered(view)).toBe(false);

			resolveY(2);
			expect(await waitFor(() => (variableValue(view, "y") === 2 ? 2 : undefined), 1500)).toBe(2);
			expect(cellRecord(view, 0)).toMatchObject({ rendered: true, names: ["x", "y"] });
			expect(hasRendered(view)).toBe(true);
		} finally {
			controller.abort();
			Reflect.deleteProperty(globalThis, "__pyobservablejsPendingY");
		}
	});

	test("publishes initial cell readback after every selected cell settles", async () => {
		let resolveDelayed!: (value: number) => void;
		let delayedEvaluationStarted = false;
		const delayed = new Promise<number>((resolve) => {
			resolveDelayed = resolve;
		});
		Object.defineProperty(globalThis, "__pyobservablejsDelayedValue", {
			configurable: true,
			get() {
				delayedEvaluationStarted = true;
				return delayed;
			},
		});
		const { view, host } = createNotebookFixture({
			_spec: {
				cells: [
					{ id: 1, mode: "ojs", value: "answer = 42" },
					{ id: 2, mode: "ojs", value: "delayed = await globalThis.__pyobservablejsDelayedValue" },
				],
			},
		});
		const controller = new AbortController();

		try {
			widget.render(renderProps(view, document.createElement("div"), controller.signal, host));
			await waitFor(() => (delayedEvaluationStarted ? true : undefined));

			expect(cellRecord(view, 0)).toBeUndefined();
			expect(hasRendered(view)).toBe(false);

			resolveDelayed(7);
			expect(await waitFor(() => (variableValue(view, "delayed") === 7 ? 7 : undefined))).toBe(7);
			expect(variableValue(view, "answer")).toBe(42);
			expect(hasRendered(view)).toBe(true);
			const snapshots = view.savedReadbacks();
			expect(
				snapshots.every((snapshot, index) => index === 0 || snapshot.revision > snapshots[index - 1]!.revision),
			).toBe(true);
			expect(snapshots.at(-1)).toMatchObject({
				rendered: true,
				graph: { cells: [{ index: 0 }, { index: 1 }] },
				cells: { "0": { rendered: true }, "1": { rendered: true } },
			});
		} finally {
			controller.abort();
			Reflect.deleteProperty(globalThis, "__pyobservablejsDelayedValue");
		}
	});

	test("invalidates stale readback and graph before publishing a changed notebook", async () => {
		let resolveAnswer!: (value: number) => void;
		let markStaleEvaluationComplete!: () => void;
		let staleEvaluationStarted = false;
		const answer = new Promise<number>((resolve) => {
			resolveAnswer = resolve;
		});
		const staleEvaluationComplete = new Promise<void>((resolve) => {
			markStaleEvaluationComplete = resolve;
		});
		Object.defineProperty(globalThis, "__pyobservablejsStaleAnswer", {
			configurable: true,
			get() {
				staleEvaluationStarted = true;
				return answer;
			},
		});
		Object.defineProperty(globalThis, "__pyobservablejsMarkStaleEvaluationComplete", {
			configurable: true,
			value: markStaleEvaluationComplete,
		});
		const { session, view, host } = createNotebookFixture({
			_spec: {
				cells: [
					{
						id: 1,
						mode: "ojs",
						value: `answer = {
  const value = await globalThis.__pyobservablejsStaleAnswer;
  globalThis.__pyobservablejsMarkStaleEvaluationComplete();
  return value;
}`,
					},
				],
			},
			_cell_keys: ["answer"],
		});
		const controller = new AbortController();
		const el = document.createElement("div");
		try {
			widget.render(renderProps(view, el, controller.signal, host));
			expect((await waitFor(() => graphValue(view))).cells[0]?.key).toBe("answer");
			await waitFor(() => (staleEvaluationStarted ? true : undefined));

			session.set("_spec", { cells: [{ id: 1, mode: "ojs", value: "total = 7" }] });
			session.set("_cell_keys", ["total"]);

			expect(await waitFor(() => (variableValue(view, "total") === 7 ? 7 : undefined))).toBe(7);
			expect((await waitFor(() => graphValue(view))).cells[0]?.key).toBe("total");
			expect(await waitFor(() => composedText(el, "7"))).toBeInstanceOf(HTMLElement);

			resolveAnswer(42);
			await staleEvaluationComplete;

			expect(variableValue(view, "total")).toBe(7);
			expect(variableValue(view, "answer")).toBeUndefined();
			expect(graphValue(view)?.cells[0]?.key).toBe("total");
		} finally {
			controller.abort();
			Reflect.deleteProperty(globalThis, "__pyobservablejsStaleAnswer");
			Reflect.deleteProperty(globalThis, "__pyobservablejsMarkStaleEvaluationComplete");
		}
	});

	test("publishes named display values and runtime errors under the cell key", async () => {
		const { view, host } = createNotebookFixture({
			_spec: {
				cells: [
					{ id: 1, mode: "ojs", value: "answer = 42" },
					{ id: 2, mode: "ojs", value: "answer + 1" },
					{ id: 3, mode: "ojs", value: "missing + 1" },
				],
			},
			_cell_keys: ["answer", "readout", "broken"],
		});
		const controller = new AbortController();
		widget.render(renderProps(view, document.createElement("div"), controller.signal, host));

		expect(await waitFor(() => (variableValue(view, "readout") === 43 ? 43 : undefined))).toBe(43);
		const error = await waitFor(() => variableValue(view, "broken") as Record<string, unknown> | undefined);
		expect(error).toMatchObject({ __observablejs_type__: "error", name: "RuntimeError" });
		expect(String(error.message)).toContain("missing is not defined");
		controller.abort();
	});

	test("uses initial Python overrides without evaluating the replaced source definition", async () => {
		const source = vi.fn(() => 1);
		Object.defineProperty(globalThis, "__pyobservablejsSourceValue", { configurable: true, value: source });
		const { view, host } = createNotebookFixture({
			_spec: {
				cells: [
					{ id: 1, mode: "ojs", value: "answer = globalThis.__pyobservablejsSourceValue()" },
					{ id: 2, mode: "ojs", value: "doubled = answer * 2" },
				],
			},
			_variables: { answer: 41 },
			_cell_keys: ["answer", "doubled"],
		});
		const controller = new AbortController();
		try {
			widget.render(renderProps(view, document.createElement("div"), controller.signal, host));
			expect(await waitFor(() => (variableValue(view, "answer") === 41 ? 41 : undefined))).toBe(41);
			expect(await waitFor(() => (variableValue(view, "doubled") === 82 ? 82 : undefined))).toBe(82);
			expect(source).not.toHaveBeenCalled();
		} finally {
			controller.abort();
			Reflect.deleteProperty(globalThis, "__pyobservablejsSourceValue");
		}
	});

	test("keeps source-backed attachments available when Python replaces source values", async () => {
		const { view, host } = createNotebookFixture({
			_source: `
<notebook>
  <script id="1" type="application/vnd.observable.javascript" name="rows">rows = [{x: 0}]</script>
  <script id="2" type="application/vnd.observable.javascript" name="count">count = rows.length</script>
  <script id="3" type="application/vnd.observable.javascript" name="attachmentUrl">attachmentUrl = FileAttachment("points.csv").url()</script>
</notebook>
`,
			_attachments: {
				"points.csv": { url: "https://static.example/points.csv", mimeType: "text/csv" },
			},
			_variables: { rows: [{ x: 10 }, { x: 20 }] },
			_cell_keys: ["rows", "count", "attachmentUrl"],
		});
		const controller = new AbortController();
		widget.render(renderProps(view, document.createElement("div"), controller.signal, host));

		expect(await waitFor(() => (variableValue(view, "count") === 2 ? 2 : undefined))).toBe(2);
		expect(variableValue(view, "rows")).toEqual([{ x: 10 }, { x: 20 }]);
		expect(await waitFor(() => variableValue(view, "attachmentUrl") as string | undefined)).toBe(
			"https://static.example/points.csv",
		);
		controller.abort();
	});

	test("clears derived state before a delayed variable replacement settles", async () => {
		let gate: Promise<number> = Promise.resolve(0);
		let resolveGate!: (value: number) => void;
		Object.defineProperty(globalThis, "__pyobservablejsReplacementGate", {
			configurable: true,
			get: () => gate,
		});
		const { session, view, host } = createNotebookFixture({
			_spec: {
				cells: [
					{
						id: 1,
						mode: "ojs",
						value: "answer = base + await globalThis.__pyobservablejsReplacementGate",
					},
				],
			},
			_variables: { base: 1 },
			_cell_keys: ["answer"],
		});
		const controller = new AbortController();
		try {
			widget.render(renderProps(view, document.createElement("div"), controller.signal, host));
			expect(await waitFor(() => (variableValue(view, "answer") === 1 ? 1 : undefined))).toBe(1);

			gate = new Promise<number>((resolve) => {
				resolveGate = resolve;
			});
			session.set("_variable_update", { seq: 1, kind: "replace", values: { base: 2 } });
			session.set("_variables", { base: 2 });

			expect(hasRendered(view)).toBe(false);
			expect(cellRecord(view, 0)).toBeUndefined();
			expect(graphValue(view)).toBeUndefined();

			resolveGate(0);
			expect(await waitFor(() => (variableValue(view, "answer") === 2 ? 2 : undefined))).toBe(2);
		} finally {
			controller.abort();
			Reflect.deleteProperty(globalThis, "__pyobservablejsReplacementGate");
		}
	});

	test("renders syntax failures as settled cell output", async () => {
		const { view, host } = createNotebookFixture({
			_spec: { cells: [{ id: 1, mode: "ojs", value: "broken =" }] },
			_cell_keys: ["broken"],
		});
		const controller = new AbortController();
		const el = document.createElement("div");
		widget.render(renderProps(view, el, controller.signal, host));

		expect(await waitFor(() => alertText(el))).toContain("SyntaxError");
		expect(await waitFor(() => (hasRendered(view) ? true : undefined))).toBe(true);
		expect(cellRecord(view, 0)).toMatchObject({ rendered: true, values: {} });
		controller.abort();
	});

	test("ending the widget lifecycle disconnects session updates", async () => {
		const { session, view, host } = createNotebookFixture({
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
					{ id: 2, mode: "ojs", value: "doubled = gain * base" },
				],
			},
			_variables: { base: 2 },
			_cell_keys: ["gain", "doubled"],
		});
		const controller = new AbortController();
		const el = document.createElement("div");
		widget.render(renderProps(view, el, controller.signal, host));
		const input = await waitFor(() => el.querySelector<HTMLInputElement>('input[type="range"]') ?? undefined);
		await waitFor(() => (variableValue(view, "doubled") === 6 ? 6 : undefined));

		controller.abort();
		session.set("_variable_update", { seq: 1, kind: "set", values: { base: 5 } });
		session.set("_variables", { base: 5 });
		session.set("_view_values", { gain: 9 });
		await new Promise<void>((resolve) => window.setTimeout(resolve, 0));

		expect(input.value).toBe("3");
		expect(variableValue(view, "gain")).toBe(3);
		expect(variableValue(view, "doubled")).toBe(6);
	});
});
