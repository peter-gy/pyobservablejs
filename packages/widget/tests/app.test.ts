import { describe, expect, test, vi } from "vite-plus/test";
import {
	alertText,
	cellRecord,
	composedText,
	createNotebookFixture,
	graphValue,
	renderProps,
	type TestModel,
	variableValue,
	waitFor,
	widget,
} from "./testing";

describe("widget graph and notebook readback", () => {
	test("renders one NotebookView runtime and publishes graph and cell readback on its view model", async () => {
		const { view, host } = createNotebookFixture({
			_spec: {
				cells: [
					{ id: 1, mode: "ojs", value: "answer = 42" },
					{ id: 2, mode: "ojs", value: "answer + 1" },
				],
			},
			_attachments: {},
			_variables: {},
			_options: {},
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
		expect(await waitFor(() => (view.get("_has_rendered") === true ? true : undefined))).toBe(true);
		expect(host.modelLookups).toEqual(["anywidget:session"]);
		expect(host.widgetLookups).toEqual([]);
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
			_attachments: {},
			_variables: {},
			_options: {},
			_cell_keys: ["metrics"],
		});
		const controller = new AbortController();
		try {
			widget.render(renderProps(view, document.createElement("div"), controller.signal, host));
			await waitFor(() => (evaluationStarted ? true : undefined));
			expect(cellRecord(view, 0)).toBeUndefined();
			expect(view.get("_has_rendered")).toBe(false);

			resolveY(2);
			expect(await waitFor(() => (variableValue(view, "y") === 2 ? 2 : undefined), 1500)).toBe(2);
			expect(cellRecord(view, 0)).toMatchObject({ rendered: true, names: ["x", "y"] });
			expect(view.get("_has_rendered")).toBe(true);
		} finally {
			controller.abort();
			Reflect.deleteProperty(globalThis, "__pyobservablejsPendingY");
		}
	});

	test("invalidates stale readback and graph before publishing a changed notebook", async () => {
		const { session, view, host } = createNotebookFixture({
			_spec: { cells: [{ id: 1, mode: "ojs", value: "answer = 42" }] },
			_attachments: {},
			_variables: {},
			_options: {},
			_cell_keys: ["answer"],
		});
		const controller = new AbortController();
		const el = document.createElement("div");
		widget.render(renderProps(view, el, controller.signal, host));
		await waitFor(() => (variableValue(view, "answer") === 42 ? 42 : undefined));

		session.set("_spec", { cells: [{ id: 1, mode: "ojs", value: "total = 7" }] });
		session.set("_cell_keys", ["total"]);

		expect(await waitFor(() => (variableValue(view, "total") === 7 ? 7 : undefined))).toBe(7);
		expect(variableValue(view, "answer")).toBeUndefined();
		expect((await waitFor(() => graphValue(view))).cells[0]?.key).toBe("total");
		expect(await waitFor(() => composedText(el, "7"))).toBeInstanceOf(HTMLElement);
		controller.abort();
	});

	test("keeps runtime output reactive across Python variable patches", async () => {
		const { session, view, host } = createNotebookFixture({
			_spec: { cells: [{ id: 1, mode: "ojs", value: "doubled = base * 2" }] },
			_attachments: {},
			_variables: { base: 1 },
			_options: {},
			_cell_keys: ["doubled"],
		});
		const controller = new AbortController();
		const el = document.createElement("div");
		widget.render(renderProps(view, el, controller.signal, host));
		const root = await waitFor(() => (el.firstElementChild instanceof HTMLElement ? el.firstElementChild : undefined));

		expect(await waitFor(() => (variableValue(view, "doubled") === 2 ? 2 : undefined))).toBe(2);
		setVariables(session, 1, { base: 3 });
		expect(await waitFor(() => (variableValue(view, "doubled") === 6 ? 6 : undefined))).toBe(6);
		setVariables(session, 2, { base: 8 });
		expect(await waitFor(() => (variableValue(view, "doubled") === 16 ? 16 : undefined))).toBe(16);
		expect(el.firstElementChild).toBe(root);
		controller.abort();
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
			_attachments: {},
			_variables: {},
			_options: {},
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
			_attachments: {},
			_variables: { answer: 41 },
			_options: {},
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
			_options: {},
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
			_options: {},
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

			expect(view.get("_has_rendered")).toBe(false);
			expect(view.get("_cell_values")).toEqual({});
			expect(view.get("_graph")).toEqual({});

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
			_attachments: {},
			_variables: {},
			_options: {},
			_cell_keys: ["broken"],
		});
		const controller = new AbortController();
		const el = document.createElement("div");
		widget.render(renderProps(view, el, controller.signal, host));

		expect(await waitFor(() => alertText(el))).toContain("SyntaxError");
		expect(await waitFor(() => (view.get("_has_rendered") === true ? true : undefined))).toBe(true);
		expect(cellRecord(view, 0)).toMatchObject({ rendered: true, values: {} });
		controller.abort();
	});
});

function setVariables(model: TestModel, seq: number, values: Record<string, unknown>): void {
	model.set("_variable_update", { seq, kind: "set", values });
	const previous = model.get("_variables");
	model.set("_variables", previous && typeof previous === "object" ? { ...previous, ...values } : values);
}
