// @vitest-environment jsdom

import { toCell } from "@observablehq/notebook-kit";
import { describe, expect, test } from "vitest";
import { renderSource } from "./highlight";

describe("source rendering", () => {
	test("preserves source text and accessible source labeling", () => {
		const controller = new AbortController();
		const panel = renderSource(toCell({ id: 1, mode: "ojs", value: "answer = 42" }), controller.signal);
		const source = panel.querySelector<HTMLPreElement>("pre[aria-label='OJS source']");

		expect(source?.textContent).toBe("answer = 42");
		expect(source?.getAttribute("aria-label")).toBe("OJS source");
		controller.abort();
	});
});
