import { expect, test } from "vite-plus/test";
import { normalizeNotebook, parseNotebookOrigin } from "../src/source";

test("reads runtime metadata from Notebook Kit HTML as the source of truth", () => {
	const origin = {
		format: "classic",
		id: "0123456789abcdef",
		version: 7,
		resolutions: { "@example/value": "fedcba9876543210@4" },
	};
	const source = `<!doctype html><notebook data-pyobservablejs-runtime-profile="observable" data-pyobservablejs-origin='${JSON.stringify(origin)}'><script id="1" type="application/vnd.observable.javascript">answer = 42</script></notebook>`;
	const normalized = normalizeNotebook(source, {
		runtimeProfile: "notebook-kit",
		origin: { id: "ignored", version: 1 },
	});
	expect(normalized.runtimeProfile).toBe("observable");
	expect(normalized.origin).toEqual(origin);
	expect(normalized.notebook.cells[0]).toMatchObject({ mode: "ojs", value: "answer = 42" });
});

test("uses explicit metadata for NotebookSpec source", () => {
	const normalized = normalizeNotebook(
		{ cells: [{ id: 1, mode: "ts", value: "const answer: number = 42;" }] },
		{ runtimeProfile: "observable", origin: { id: "0123456789abcdef", version: 3 } },
	);
	expect(normalized.runtimeProfile).toBe("observable");
	expect(normalized.origin).toEqual({ id: "0123456789abcdef", version: 3 });
	expect(normalized.notebook.cells[0]?.mode).toBe("ts");
});

test("parses revision mappings without prototype setters", () => {
	const value = JSON.parse(
		'{"id":"0123456789abcdef","version":4,"format":"classic","resolutions":{"__proto__":"fedcba9876543210@2"}}',
	);
	const origin = parseNotebookOrigin(value);
	expect(origin.resolutions?.["__proto__"]).toBe("fedcba9876543210@2");
	expect(Object.prototype.hasOwnProperty.call(origin.resolutions, "__proto__")).toBe(true);
});
