// @vitest-environment jsdom

import { describe, expect, test } from "vitest";
import { readNotebookFromModel, readNotebookTheme } from "./model";
import { createModel } from "./testing";

describe("widget notebook model", () => {
	test("reads the synced theme trait for spec-backed notebooks", () => {
		const model = createModel({
			spec: {
				theme: "air",
				cells: [{ id: 1, mode: "ojs", value: "answer = 42" }],
			},
			theme: "slate",
		});

		const notebook = readNotebookFromModel(model);

		expect(notebook.theme).toBe("slate");
	});

	test("reads the synced theme trait for source-backed notebooks", () => {
		const model = createModel({
			source: '<!doctype html><notebook theme="air"><script id="1">answer = 42</script></notebook>',
			theme: { light: "cotton", dark: "slate" },
		});

		const notebook = readNotebookFromModel(model);

		expect(notebook.theme).toEqual({ light: "cotton", dark: "slate" });
	});

	test("ignores malformed theme trait values", () => {
		const model = createModel({
			theme: { light: "cotton" },
		});

		expect(readNotebookTheme(model)).toBeUndefined();
	});
});
