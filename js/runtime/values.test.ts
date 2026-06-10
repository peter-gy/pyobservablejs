// @vitest-environment jsdom

import { describe, expect, test } from "vitest";
import { createVariableBuiltins, isWritableSyncedViewValue, reviveSyncedValue, toWireValue } from "./values";

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
			when: { __pyobservablejs_type__: "datetime", value: "2026-05-23" },
			raw: { __pyobservablejs_type__: "bytes", value: "YWJj" },
			invalid: { __pyobservablejs_type__: "number", value: "NaN" },
		});

		expect(builtins.when()).toEqual(new Date("2026-05-23"));
		expect(builtins.raw()).toEqual(new Uint8Array([97, 98, 99]));
		expect(Number.isNaN(builtins.invalid() as number)).toBe(true);
	});

	test("revives Python bigints without losing integer precision", () => {
		const builtins = createVariableBuiltins({
			huge: { __pyobservablejs_type__: "bigint", value: "9007199254740993" },
		});

		expect(builtins.huge()).toBe(9007199254740993n);
	});

	test("escapes user objects that contain the reserved wire tag key", () => {
		const value = {
			__pyobservablejs_type__: "datetime",
			value: "not a date",
			other: 1,
		};
		const builtins = createVariableBuiltins({
			row: { __pyobservablejs_type__: "object", value },
		});

		expect(reviveSyncedValue(toWireValue(value))).toEqual(value);
		expect(builtins.row()).toEqual(value);
	});

	test("does not treat browser object summaries as writable view values", () => {
		expect(isWritableSyncedViewValue(toWireValue(document.createElement("img")))).toBe(false);
		expect(isWritableSyncedViewValue({ pointDensity: 21 })).toBe(true);
	});
});
