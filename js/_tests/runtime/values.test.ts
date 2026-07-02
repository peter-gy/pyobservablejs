// @vitest-environment jsdom

import { describe, expect, test } from "vitest";
import {
	createVariableBuiltins,
	isWritableSyncedViewValue,
	reviveSyncedValue,
	sameWireValue,
	toWireValue,
} from "@/runtime/values";

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

	test("revives Python bigints without losing integer precision", () => {
		const builtins = createVariableBuiltins({
			huge: { __observablejs_type__: "bigint", value: "9007199254740993" },
		});

		expect(builtins.huge()).toBe(9007199254740993n);
	});

	test("escapes user objects that contain the reserved wire tag key", () => {
		const value = {
			__observablejs_type__: "datetime",
			value: "not a date",
			other: 1,
		};
		const builtins = createVariableBuiltins({
			row: { __observablejs_type__: "object", value },
		});

		expect(reviveSyncedValue(toWireValue(value))).toEqual(value);
		expect(builtins.row()).toEqual(value);
	});

	test("does not treat browser object summaries as writable view values", () => {
		expect(isWritableSyncedViewValue(toWireValue(document.createElement("img")))).toBe(false);
		expect(isWritableSyncedViewValue({ pointDensity: 21 })).toBe(true);
	});

	test("compares wire values without serializing large payloads", () => {
		const payload = { rows: Array.from({ length: 100 }, (_, index) => ({ index })) };
		Object.defineProperty(payload, "toJSON", {
			value() {
				throw new RangeError("Invalid string length");
			},
		});

		expect(sameWireValue({}, { payload })).toBe(false);
		expect(sameWireValue({ payload }, { payload })).toBe(true);
	});

	test("summarizes deeply nested values before stack overflow", () => {
		let value: Record<string, unknown> = { leaf: true };
		for (let index = 0; index < 1_000; index++) value = { next: value };

		expect(hasWireSummary(toWireValue(value))).toBe(true);
	});

	test("summarizes detached binary buffers", () => {
		const buffer = new ArrayBuffer(8);
		const typed = new Uint8Array([1, 2, 3]);
		structuredClone(buffer, { transfer: [buffer] });
		structuredClone(typed.buffer, { transfer: [typed.buffer] });

		expect(toWireValue(buffer)).toEqual({ __observablejs_type__: "summary", value: "ArrayBuffer(detached)" });
		expect(toWireValue(typed)).toEqual({ __observablejs_type__: "summary", value: "Uint8Array(detached)" });
	});

	test("serializes invalid dates without throwing", () => {
		expect(toWireValue(new Date(Number.NaN))).toEqual({
			__observablejs_type__: "datetime",
			value: "Invalid Date",
		});
	});
});

function hasWireSummary(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	if (Array.isArray(value)) return value.some(hasWireSummary);
	const record = value as Record<string, unknown>;
	if (record.__observablejs_type__ === "summary") return true;
	return Object.values(record).some(hasWireSummary);
}
