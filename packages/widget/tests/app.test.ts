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
	test("shows source only for cells explicitly pinned by Python", async () => {
		const { view, host } = createNotebookFixture({
			_spec: {
				cells: [
					{ id: 1, mode: "js", value: "const plain = 1;", pinned: false },
					{ id: 2, mode: "js", value: "const featured = 2;", pinned: true },
				],
			},
			_options: { show_source: true },
			_cell_keys: ["plain", "featured"],
		});
		const controller = new AbortController();
		const el = document.createElement("div");

		try {
			widget.render(renderProps(view, el, controller.signal, host));
			const panel = await waitFor(() => el.querySelector<HTMLElement>(".pyobservablejs-source-panel") ?? undefined);
			expect(el.querySelectorAll(".pyobservablejs-source-panel")).toHaveLength(1);
			expect(panel.textContent).toContain("const featured = 2;");
		} finally {
			controller.abort();
		}
	});

	test("marks an empty notebook rendered with a complete graph", async () => {
		const { view, host } = createNotebookFixture({ _spec: { cells: [] } });
		const controller = new AbortController();

		try {
			widget.render(renderProps(view, document.createElement("div"), controller.signal, host));
			expect(await waitFor(() => (hasRendered(view) ? true : undefined))).toBe(true);
			expect(graphValue(view)).toEqual({ cells: [], edges: [] });
			expect(view.savedReadbacks().at(-1)).toMatchObject({
				input_revision: 0,
				settled_revision: 0,
				pending: false,
				results: {},
				errors: [],
			});
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

	test("renders without publishing browser state when capture is disabled", async () => {
		const { view, host } = createNotebookFixture({
			_spec: {
				cells: [{ id: 1, mode: "ojs", value: "answer = 42" }],
			},
			_cell_keys: ["answer"],
		});
		view.set("_capture_state", false);
		const controller = new AbortController();
		const el = document.createElement("div");

		try {
			widget.render(renderProps(view, el, controller.signal, host));
			expect(await waitFor(() => (el.textContent?.includes("42") ? true : undefined))).toBe(true);
			expect(view.saveCount()).toBe(0);
			expect(view.savedReadbacks()).toEqual([]);
		} finally {
			controller.abort();
		}
	});

	test("renders selected values without serializing them when capture is disabled", async () => {
		Object.defineProperty(globalThis, "__pyobservablejsSerializationAttempts", {
			configurable: true,
			writable: true,
			value: 0,
		});
		const { view, host } = createNotebookFixture({
			_spec: {
				cells: [
					{
						id: 1,
						mode: "ojs",
						hidden: true,
						value: `value = new Proxy({}, {
  ownKeys(target) {
    globalThis.__pyobservablejsSerializationAttempts += 1;
    return Reflect.ownKeys(target);
  }
})`,
					},
					{
						id: 2,
						mode: "ojs",
						value: "answer = 42",
					},
				],
			},
			_cell_keys: ["value", "answer"],
		});
		view.set("_cell_indexes", [0, 1]);
		view.set("_capture_state", false);
		const controller = new AbortController();
		const el = document.createElement("div");

		try {
			widget.render(renderProps(view, el, controller.signal, host));
			expect(await waitFor(() => (el.textContent?.includes("42") ? true : undefined))).toBe(true);
			expect(Reflect.get(globalThis, "__pyobservablejsSerializationAttempts")).toBe(0);
			expect(view.saveCount()).toBe(0);
			expect(view.savedReadbacks()).toEqual([]);
		} finally {
			controller.abort();
			Reflect.deleteProperty(globalThis, "__pyobservablejsSerializationAttempts");
		}
	});

	test("rejects an invalid capture-state wire value", () => {
		const { view, host } = createNotebookFixture({
			_spec: { cells: [] },
		});
		// Static hosts can supply model state without passing TypeScript checks.
		view.set("_capture_state", "no" as never);
		const controller = new AbortController();
		const el = document.createElement("div");

		try {
			widget.render(renderProps(view, el, controller.signal, host));
			expect(alertText(el)).toBe("Error: NotebookView capture state must be a boolean");
		} finally {
			controller.abort();
		}
	});

	test("publishes only internally consistent readback snapshots", async () => {
		const { view, host } = createNotebookFixture({
			_spec: { cells: [{ id: 1, mode: "ojs", value: "answer = 42" }] },
			_cell_keys: ["answer"],
		});
		const controller = new AbortController();

		try {
			widget.render(renderProps(view, document.createElement("div"), controller.signal, host));
			await waitFor(() => (hasRendered(view) ? true : undefined));

			expect(
				view.savedReadbacks().every((snapshot) => {
					if (snapshot.input_revision === null) {
						return snapshot.settled_revision === null && !snapshot.pending;
					}
					return snapshot.pending || snapshot.settled_revision === snapshot.input_revision;
				}),
			).toBe(true);
		} finally {
			controller.abort();
		}
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
			expect(cellRecord(view, 0)).toMatchObject({ status: "pending", values: {}, errors: [] });
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

			expect(cellRecord(view, 0)).toMatchObject({ status: "success", values: { answer: 42 } });
			expect(cellRecord(view, 1)).toMatchObject({ status: "pending", values: {}, errors: [] });
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
				pending: false,
				graph: { cells: [{ index: 0 }, { index: 1 }] },
				results: { "0": { status: "success" }, "1": { status: "success" } },
			});
		} finally {
			controller.abort();
			Reflect.deleteProperty(globalThis, "__pyobservablejsDelayedValue");
		}
	});

	test("keeps an unaffected cell pending across an overlapping input revision", async () => {
		let resolveSlow!: (value: number) => void;
		let slowEvaluationStarted = false;
		const slow = new Promise<number>((resolve) => {
			resolveSlow = resolve;
		});
		Object.defineProperty(globalThis, "__pyobservablejsOverlappingSlow", {
			configurable: true,
			get() {
				slowEvaluationStarted = true;
				return slow;
			},
		});
		const { session, view, host } = createNotebookFixture({
			_spec: {
				cells: [
					{ id: 1, mode: "ojs", value: "slow = await globalThis.__pyobservablejsOverlappingSlow" },
					{ id: 2, mode: "ojs", value: "doubled = base * 2" },
				],
			},
			_variables: { base: 1 },
			_cell_keys: ["slow", "doubled"],
		});
		const controller = new AbortController();
		try {
			widget.render(renderProps(view, document.createElement("div"), controller.signal, host));
			await waitFor(() => (slowEvaluationStarted ? true : undefined));
			expect(await waitFor(() => (variableValue(view, "doubled") === 2 ? true : undefined))).toBe(true);

			session.set("_variable_update", { seq: 1, kind: "set", values: { base: 2 } });
			session.set("_variables", { base: 2 });
			expect(await waitFor(() => (variableValue(view, "doubled") === 4 ? true : undefined))).toBe(true);
			expect(cellRecord(view, 0)).toMatchObject({ status: "pending" });
			expect(view.savedReadbacks().at(-1)).toMatchObject({ pending: true });

			resolveSlow(7);
			expect(await waitFor(() => (variableValue(view, "slow") === 7 ? true : undefined), 1500)).toBe(true);
			expect(await waitFor(() => (hasRendered(view) ? true : undefined), 1500)).toBe(true);
			expect(view.savedReadbacks().at(-1)).toMatchObject({
				pending: false,
				results: {
					"0": { status: "success", values: { slow: 7 } },
					"1": { status: "success", values: { doubled: 4 } },
				},
			});
		} finally {
			controller.abort();
			Reflect.deleteProperty(globalThis, "__pyobservablejsOverlappingSlow");
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
		const broken = await waitFor(() => {
			const result = cellRecord(view, 2);
			return result?.status === "error" ? result : undefined;
		});
		expect(broken.values).toEqual({});
		expect(broken.errors).toHaveLength(1);
		expect(broken.errors[0]).toMatchObject({ phase: "evaluation" });
		expect(String((broken.errors[0] as { message?: unknown }).message)).toContain("missing is not defined");
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
			expect(cellRecord(view, 0)).toMatchObject({ status: "pending", values: {}, errors: [] });
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
		expect(cellRecord(view, 0)).toMatchObject({ status: "error", values: {} });
		expect(cellRecord(view, 0)?.errors[0]).toMatchObject({ phase: "analysis" });
		controller.abort();
	});

	test("returns intentional JavaScript Error values as successful structured data", async () => {
		const { view, host } = createNotebookFixture({
			_spec: { cells: [{ id: 1, mode: "ojs", value: 'problem = new TypeError("invalid value")' }] },
			_cell_keys: ["problem"],
		});
		const controller = new AbortController();
		widget.render(renderProps(view, document.createElement("div"), controller.signal, host));

		const result = await waitFor(() => {
			const current = cellRecord(view, 0);
			return current?.status === "success" ? current : undefined;
		});
		expect(result.errors).toEqual([]);
		expect(result.values.problem).toEqual({
			__observablejs_type__: "error",
			name: "TypeError",
			message: "invalid value",
		});
		controller.abort();
	});

	test("keeps successful outputs beside a rejected output error", async () => {
		const { view, host } = createNotebookFixture({
			_spec: {
				cells: [
					{
						id: 1,
						mode: "js",
						value: 'const good = 42; const bad = Promise.reject(new TypeError("invalid value"));',
					},
				],
			},
			_cell_keys: ["mixed"],
		});
		const controller = new AbortController();
		widget.render(renderProps(view, document.createElement("div"), controller.signal, host));

		const result = await waitFor(() => {
			const current = cellRecord(view, 0);
			return current?.status === "error" ? current : undefined;
		});
		expect(result.values).toEqual({ good: 42 });
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toMatchObject({
			name: "RuntimeError",
			message: "invalid value",
			phase: "evaluation",
			variable: "bad",
		});
		controller.abort();
	});

	test("classifies hidden output serialization failures", async () => {
		const { view, host } = createNotebookFixture({
			_spec: {
				cells: [
					{
						id: 1,
						mode: "ojs",
						hidden: true,
						value: `value = new Proxy({}, {
  ownKeys() { throw new TypeError("cannot serialize"); }
})`,
					},
				],
			},
			_cell_keys: ["value"],
		});
		const controller = new AbortController();
		widget.render(renderProps(view, document.createElement("div"), controller.signal, host));

		const result = await waitFor(() => {
			const current = cellRecord(view, 0);
			return current?.status === "error" ? current : undefined;
		});
		expect(result.errors[0]).toMatchObject({
			name: "TypeError",
			message: "cannot serialize",
			phase: "serialization",
			variable: "value",
		});
		controller.abort();
	});

	test("classifies display inspection failures as rendering errors", async () => {
		const { view, host } = createNotebookFixture({
			_spec: {
				cells: [
					{
						id: 1,
						mode: "ojs",
						value: `new Proxy({}, {
  ownKeys() { throw new TypeError("cannot inspect"); }
})`,
					},
				],
			},
			_cell_keys: ["preview"],
		});
		const controller = new AbortController();
		widget.render(renderProps(view, document.createElement("div"), controller.signal, host));

		const result = await waitFor(() => {
			const current = cellRecord(view, 0);
			return current?.status === "error" ? current : undefined;
		});
		expect(result.errors[0]).toMatchObject({
			name: "TypeError",
			message: "cannot inspect",
			phase: "rendering",
			variable: "preview",
		});
		controller.abort();
	});

	test("reports named display failures beside successfully serialized values", async () => {
		const { view, host } = createNotebookFixture({
			_spec: {
				cells: [
					{
						id: 1,
						mode: "ojs",
						value: `value = new Proxy({}, {
  get(target, property) {
    if (property === Symbol.toStringTag) throw new TypeError("cannot inspect");
    return Reflect.get(target, property);
  }
})`,
					},
				],
			},
			_cell_keys: ["value"],
		});
		const controller = new AbortController();
		widget.render(renderProps(view, document.createElement("div"), controller.signal, host));

		const result = await waitFor(() => {
			const current = cellRecord(view, 0);
			return current?.status === "error" ? current : undefined;
		});
		expect(result.values).toEqual({ value: {} });
		expect(result.errors).toContainEqual({
			name: "TypeError",
			message: "cannot inspect",
			phase: "rendering",
		});
		controller.abort();
	});

	test("recovers a failed cell on the next Python input revision", async () => {
		const { session, view, host } = createNotebookFixture({
			_spec: {
				cells: [
					{
						id: 1,
						mode: "ojs",
						value: `answer = {
  if (broken) throw new TypeError("invalid value");
  return 42;
}`,
					},
				],
			},
			_variables: { broken: true },
			_cell_keys: ["answer"],
		});
		const controller = new AbortController();
		widget.render(renderProps(view, document.createElement("div"), controller.signal, host));

		const failed = await waitFor(() => {
			const current = cellRecord(view, 0);
			return current?.status === "error" ? current : undefined;
		});
		const failedRevision = failed.revision;
		expect(view.savedReadbacks().at(-1)).toMatchObject({
			input_revision: failedRevision,
			settled_revision: failedRevision,
			pending: false,
		});

		session.set("_variable_update", { seq: 1, kind: "set", values: { broken: false } });
		session.set("_variables", { broken: false });

		const recovered = await waitFor(() => {
			const current = cellRecord(view, 0);
			return current?.status === "success" && current.revision > failedRevision ? current : undefined;
		});
		expect(recovered.values).toEqual({ answer: 42 });
		expect(recovered.errors).toEqual([]);
		expect(view.savedReadbacks().at(-1)).toMatchObject({
			input_revision: recovered.revision,
			settled_revision: recovered.revision,
			pending: false,
		});
		controller.abort();
	});

	test("opens a fresh revision for spontaneous generator output", async () => {
		let releaseNext!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseNext = resolve;
		});
		Object.defineProperty(globalThis, "__pyobservablejsPulseSequence", {
			configurable: true,
			value: async function* () {
				yield 1;
				await gate;
				yield 2;
			},
		});
		const { view, host } = createNotebookFixture({
			_spec: {
				cells: [{ id: 1, mode: "ojs", value: "pulse = globalThis.__pyobservablejsPulseSequence()" }],
			},
			_cell_keys: ["pulse"],
		});
		const controller = new AbortController();
		try {
			widget.render(renderProps(view, document.createElement("div"), controller.signal, host));
			const first = await waitFor(() => {
				const current = cellRecord(view, 0);
				return current?.status === "success" && current.values.pulse === 1 ? current : undefined;
			});

			releaseNext();

			const second = await waitFor(() => {
				const current = cellRecord(view, 0);
				return current?.status === "success" && current.revision > first.revision && current.values.pulse === 2
					? current
					: undefined;
			}, 1500);
			expect(second.errors).toEqual([]);
			expect(view.savedReadbacks().at(-1)).toMatchObject({
				input_revision: second.revision,
				settled_revision: second.revision,
				pending: false,
			});
		} finally {
			controller.abort();
			Reflect.deleteProperty(globalThis, "__pyobservablejsPulseSequence");
		}
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
