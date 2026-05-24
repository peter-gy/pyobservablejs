// @vitest-environment jsdom

import { toCell } from "@observablehq/notebook-kit";
import { describe, expect, test } from "vitest";
import { renderSource } from "./highlight";

describe("source highlighting", () => {
	test("renders a plain source fallback and upgrades to Shiki tokens", async () => {
		const source = "answer = 42\nPlot.plot({marks: []})";
		const panel = renderSource(
			toCell({ id: 1, mode: "ojs", value: source, pinned: true }),
			new AbortController().signal,
		);
		document.body.appendChild(panel);

		expect(panel.querySelector(".observablejs-source-label")?.textContent).toBe("OJS");
		expect(panel.querySelector("code")?.textContent).toBe(source);

		const pre = await waitFor(() => {
			const source = panel.querySelector<HTMLPreElement>(".observablejs-source");
			return source?.dataset.highlight === "ready" ? source : undefined;
		});

		expect(pre.textContent).toBe(source);
		expect(pre.querySelectorAll(".observablejs-source-line")).toHaveLength(2);
		expect(pre.querySelector(".observablejs-source-token")).not.toBeNull();
	});
});

async function waitFor<T>(read: () => T | undefined): Promise<T> {
	const deadline = performance.now() + 3000;
	return new Promise<T>((resolve, reject) => {
		const check = () => {
			const value = read();
			if (value !== undefined) {
				resolve(value);
			} else if (performance.now() >= deadline) {
				reject(new Error("Timed out waiting for value"));
			} else {
				window.setTimeout(check, 10);
			}
		};
		check();
	});
}
