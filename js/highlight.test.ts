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

		const label = panel.querySelector(".observablejs-source-label");
		const pre = panel.querySelector<HTMLPreElement>(".observablejs-source");
		expect(label?.textContent).toBe("OJS");
		expect(panel.querySelector(".observablejs-source-header")).toBeNull();
		expect(pre?.nextElementSibling).toBe(label);
		expect(pre?.contains(label)).toBe(false);
		expect(pre?.getAttribute("aria-label")).toBe("OJS source");
		expect(panel.querySelector("code")?.textContent).toBe(source);

		const highlighted = await waitFor(() => {
			const sourcePre = panel.querySelector<HTMLPreElement>(".observablejs-source");
			return sourcePre?.dataset.highlight === "ready" ? sourcePre : undefined;
		});

		expect(highlighted.textContent).toBe(source);
		expect(highlighted.querySelectorAll(".observablejs-source-line")).toHaveLength(2);
		expect(highlighted.querySelector(".observablejs-source-token")).not.toBeNull();
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
