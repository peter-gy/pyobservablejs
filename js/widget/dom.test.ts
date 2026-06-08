// @vitest-environment jsdom

import { toCell } from "@observablehq/notebook-kit";
import { describe, expect, test } from "vitest";
import { createNotebookRoot, renderSource, SELECTORS } from "./dom";

describe("source rendering", () => {
	test("preserves source text and accessible source labeling", () => {
		const controller = new AbortController();
		const panel = renderSource(toCell({ id: 1, mode: "ojs", value: "answer = 42" }), controller.signal);
		const source = panel.querySelector<HTMLPreElement>(SELECTORS.source);

		expect(source?.textContent).toBe("answer = 42");
		expect(source?.getAttribute("aria-label")).toBe("OJS source");
		controller.abort();
	});
});

describe("notebook theme root", () => {
	test("marks string themes on the scoped notebook root", () => {
		const parent = document.createElement("div");
		const root = createNotebookRoot(parent, "slate");

		expect(root.dataset.theme).toBe("slate");
		expect(root.dataset.themeLight).toBeUndefined();
		expect(root.dataset.themeDark).toBeUndefined();
		expect(parent.firstElementChild).toBe(root);
	});

	test("marks light-dark themes on the scoped notebook root", () => {
		const parent = document.createElement("div");
		const root = createNotebookRoot(parent, { light: "cotton", dark: "slate" });

		expect(root.dataset.theme).toBe("light-dark");
		expect(root.dataset.themeLight).toBe("cotton");
		expect(root.dataset.themeDark).toBe("slate");
	});
});
