import type { Cell, transpile } from "@observablehq/notebook-kit";
import { describe, expect, test } from "vitest";
import { createRuntimeDefinition } from "./definition";

describe("runtime definitions", () => {
	test("awaits template inputs without replacing the previous value receiver", async () => {
		const definition = createRuntimeDefinition(
			{ id: 1, mode: "md", value: "" } as Cell,
			{
				body: 'function(md, gain) { return {receiver: this, text: md([`${this ? "updated" : "initial"} ${gain}`])}; }',
				inputs: ["md", "gain"],
				outputs: [],
				autodisplay: true,
				autoview: false,
				automutable: false,
			} as ReturnType<typeof transpile>,
		);
		const renderMarkdown = (parts: readonly string[]) => parts[0];
		const previous = { rendered: true };

		await expect(definition.body.call(undefined, Promise.resolve(renderMarkdown), 1)).resolves.toEqual({
			receiver: undefined,
			text: "initial 1",
		});
		await expect(definition.body.call(previous, Promise.resolve(renderMarkdown), 2)).resolves.toEqual({
			receiver: previous,
			text: "updated 2",
		});
	});
});
