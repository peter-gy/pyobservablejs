// @vitest-environment jsdom

import { describe, expect, test } from "vitest";
import { normalizeMarkdownRenderer, type MarkdownRenderer } from "./markdown";

type CapturedMarkdownCall = {
	template: readonly string[];
	values: unknown[];
};

describe("Observable markdown compatibility", () => {
	test("normalizes strong delimiter whitespace outside code fences", () => {
		expect(captureMarkdown("** Heading**\n\n    ** example**")).toEqual({
			template: ["**Heading**\n\n    ** example**"],
			values: [],
		});
	});

	test("leaves fenced markdown examples unchanged", () => {
		const source = ["** Heading**", "", "````md", "```md", "** example**", "```", "````"].join("\n");

		expect(captureMarkdown(source)).toEqual({
			template: [["**Heading**", "", "````md", "```md", "** example**", "```", "````"].join("\n")],
			values: [],
		});
	});

	test("leaves blockquoted fenced markdown examples unchanged", () => {
		const source = ["** Heading**", "", "> ```md", "> ** example**", "> ```"].join("\n");

		expect(captureMarkdown(source)).toEqual({
			template: [["**Heading**", "", "> ```md", "> ** example**", "> ```"].join("\n")],
			values: [],
		});
	});

	test("keeps interpolated fences open across template chunks", () => {
		const call = captureMarkdown(["** Heading**\n\n````md\n", "\n** example**\n````"], "");

		expect(call).toEqual({
			template: ["**Heading**\n\n````md\n\n** example**\n````"],
			values: [],
		});
	});

	test("uses primitive interpolations while detecting code fences", () => {
		const call = captureMarkdown(["** Heading**\n\n", "\n** example**\n````"], "````md");

		expect(call).toEqual({
			template: ["**Heading**\n\n````md\n** example**\n````"],
			values: [],
		});
	});
});

function captureMarkdown(template: TemplateStringsArray | readonly string[] | string, ...values: unknown[]) {
	const renderer = ((parts: readonly string[], ...items: unknown[]): CapturedMarkdownCall => ({
		template: Array.from(parts),
		values: items,
	})) as unknown as MarkdownRenderer;
	const normalized = normalizeMarkdownRenderer(renderer);
	const parts = typeof template === "string" ? [template] : template;
	return normalized(parts, ...values) as unknown as CapturedMarkdownCall;
}
