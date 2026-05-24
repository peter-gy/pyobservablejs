// @vitest-environment jsdom

import { describe, expect, test } from "vitest";
import { createVariableBuiltins, reviveSyncedValue, toWireValue } from "./wire";

describe("wire values", () => {
	test("round trips synced numbers, dates, maps, and sets", () => {
		const date = new Date("2026-05-23T00:00:00.000Z");
		const value = {
			invalid: Number.NaN,
			when: date,
			items: new Set(["a", "b"]),
			lookup: new Map([["k", 7]]),
		};

		const revived = reviveSyncedValue(toWireValue(value));

		expect(revived).toEqual({
			invalid: Number.NaN,
			when: date,
			items: new Set(["a", "b"]),
			lookup: new Map([["k", 7]]),
		});
	});

	test("revives Python variables as Observable builtins", () => {
		const builtins = createVariableBuiltins({
			when: { __observablejs_type__: "datetime", value: "2026-05-23" },
			raw: { __observablejs_type__: "bytes", value: "YWJj" },
			invalid: { __observablejs_type__: "number", value: "NaN" },
		});

		expect(builtins.when()).toEqual(new Date("2026-05-23"));
		expect(builtins.raw()).toEqual(new Uint8Array([97, 98, 99]));
		expect(Number.isNaN(builtins.invalid() as number)).toBe(true);
	});
});
