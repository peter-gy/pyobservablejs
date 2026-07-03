// @vitest-environment jsdom

import { describe, expect, test } from "vitest";
import {
	createVariableBuiltins,
	isWritableSyncedViewValue,
	reviveSyncedValue,
	sameWireValue,
	toWireValue,
	writeViewValue,
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

	test("summarizes deep objects without invoking constructor accessors", () => {
		let constructorRead = false;
		let value: Record<string, unknown> = { leaf: true };
		Object.defineProperty(value, "constructor", {
			get() {
				constructorRead = true;
				throw new Error("constructor accessor should not run during wire summarization");
			},
		});
		for (let index = 0; index < 100; index++) value = { next: value };

		expect(hasWireSummary(toWireValue(value))).toBe(true);
		expect(constructorRead).toBe(false);
	});

	test("summarizes detached binary buffers", () => {
		const buffer = new ArrayBuffer(8);
		const typed = new Uint8Array([1, 2, 3]);
		structuredClone(buffer, { transfer: [buffer] });
		structuredClone(typed.buffer, { transfer: [typed.buffer] });

		expect(toWireValue(buffer)).toEqual({ __observablejs_type__: "summary", value: "ArrayBuffer(detached)" });
		expect(toWireValue(typed)).toEqual({ __observablejs_type__: "summary", value: "Uint8Array(detached)" });
	});

	test("serializes invalid dates as non-writable summaries", () => {
		const value = toWireValue(new Date(Number.NaN));

		expect(value).toEqual({
			__observablejs_type__: "summary",
			value: "Invalid Date",
		});
		expect(isWritableSyncedViewValue(value)).toBe(false);
	});

	test("does not throw when invalid dates are replayed into date inputs", () => {
		const input = document.createElement("input");
		input.type = "date";

		expect(writeViewValue(input, new Date(Number.NaN))).toBe("unsupported");
		expect(input.value).toBe("");
	});

	test("serializes valid dates as datetimes", () => {
		expect(toWireValue(new Date("2026-05-23T00:00:00.000Z"))).toEqual({
			__observablejs_type__: "datetime",
			value: "2026-05-23T00:00:00.000Z",
		});
	});

	test("serializes arrays without calling shadowed array methods", () => {
		const value = [1, 2];
		Object.defineProperty(value, "map", {
			value: undefined,
		});

		expect(toWireValue(value)).toEqual([1, 2]);
	});

	test("serializes array subclasses without calling species constructors", () => {
		class RuntimeArray extends Array<number> {}
		Object.defineProperty(RuntimeArray, Symbol.species, {
			get: () =>
				class {
					constructor() {
						throw new Error("species constructor should not run during wire serialization");
					}
				},
		});
		const value = new RuntimeArray();
		value.push(1, 2);

		expect(toWireValue(value)).toEqual([1, 2]);
	});

	test("serializes object data properties without invoking accessors", () => {
		let getterRead = false;
		const value = { ready: true };
		Object.defineProperty(value, "lazy", {
			enumerable: true,
			get() {
				getterRead = true;
				throw new Error("accessor should not run during wire serialization");
			},
		});

		expect(toWireValue(value)).toEqual({ ready: true });
		expect(getterRead).toBe(false);
	});

	test("compares object data properties without invoking accessors", () => {
		let getterRead = false;
		const left = { ready: true };
		Object.defineProperty(left, "lazy", {
			enumerable: true,
			get() {
				getterRead = true;
				throw new Error("accessor should not run during wire comparison");
			},
		});

		expect(sameWireValue(left, { ready: true })).toBe(true);
		expect(getterRead).toBe(false);
	});

	test("compares cyclic wire values without stringifying them", () => {
		const left: Record<string, unknown> = { ready: true };
		left.self = left;
		const right: Record<string, unknown> = { ready: true };
		right.self = right;

		expect(sameWireValue(left, right)).toBe(true);
		right.ready = false;
		expect(sameWireValue(left, right)).toBe(false);
	});
});

function hasWireSummary(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	if (Array.isArray(value)) return value.some(hasWireSummary);
	const record = value as Record<string, unknown>;
	if (record.__observablejs_type__ === "summary") return true;
	return Object.values(record).some(hasWireSummary);
}
