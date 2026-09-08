import { describe, expect, test } from "vite-plus/test";
import {
	revivePythonValue,
	isWritableSyncedViewValue,
	reviveSyncedValue,
	sameWireValue,
	toWireValue,
} from "../src/values";

interface NestedValue {
	leaf?: boolean;
	next?: NestedValue;
}

interface CyclicValue {
	ready: boolean;
	self?: CyclicValue;
}

describe("wire values", () => {
	test("round trips synced numbers, dates, maps, and sets", () => {
		const date = new Date("2026-05-23T00:00:00.000Z");
		const value = {
			invalid: Number.NaN,
			when: date,
			items: new Set(["a", "b"]),
			lookup: new Map([["k", 7]]),
		};

		expect(toWireValue(date)).toEqual({ __observablejs_type__: "datetime", value: "2026-05-23T00:00:00.000Z" });
		const revived = reviveSyncedValue(toWireValue(value));

		expect(revived).toEqual({
			invalid: Number.NaN,
			when: date,
			items: new Set(["a", "b"]),
			lookup: new Map([["k", 7]]),
		});
	});

	test("revives Python dates, bytes, and exact numeric values", () => {
		const variables = {
			when: { __observablejs_type__: "datetime", value: "2026-05-23" },
			raw: { __observablejs_type__: "bytes", value: "YWJj" },
			invalid: { __observablejs_type__: "number", value: "NaN" },
			huge: { __observablejs_type__: "bigint", value: "9007199254740993" },
		} as const;

		expect(revivePythonValue(variables.when)).toEqual(new Date("2026-05-23"));
		expect(revivePythonValue(variables.raw)).toEqual(new Uint8Array([97, 98, 99]));
		expect(revivePythonValue(variables.invalid)).toBeNaN();
		expect(revivePythonValue(variables.huge)).toBe(9007199254740993n);
	});

	test("escapes user objects that contain the reserved wire tag key", () => {
		const value = {
			__observablejs_type__: "datetime",
			value: "not a date",
			other: 1,
		};
		const variables = {
			row: { __observablejs_type__: "object", value },
		} as const;

		expect(reviveSyncedValue(toWireValue(value))).toEqual(value);
		expect(revivePythonValue(variables.row)).toEqual(value);
	});

	test("classifies browser object summaries as non-writable view values", () => {
		expect(isWritableSyncedViewValue(toWireValue(document.createElement("img")))).toBe(false);
		expect(isWritableSyncedViewValue({ pointDensity: 21 })).toBe(true);
	});

	test("summarizes deep objects without invoking constructor accessors", () => {
		let constructorRead = false;
		let value: NestedValue = { leaf: true };
		for (let index = 0; index < 1_000; index++) value = { next: value };
		const prototype = {};
		Object.defineProperty(prototype, "constructor", {
			get() {
				constructorRead = true;
				throw new Error("constructor accessor should not run during wire summarization");
			},
		});
		Object.setPrototypeOf(value, prototype);

		expect(toWireValue(value)).toEqual({ __observablejs_type__: "summary", value: "Object" });
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

	test("serializes array subclasses with custom methods and species", () => {
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
		Object.defineProperty(value, "map", { value: undefined });

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
		const left: CyclicValue = { ready: true };
		left.self = left;
		const right: CyclicValue = { ready: true };
		right.self = right;

		expect(sameWireValue(left, right)).toBe(true);
		right.ready = false;
		expect(sameWireValue(left, right)).toBe(false);
	});

	test("summarizes wide arrays as one value", () => {
		const values = Array.from({ length: 100_000 }, (_, index) => index);
		const first = toWireValue(values);
		expect(first).toEqual({ __observablejs_type__: "summary", value: "Array(100000)" });
		expect(sameWireValue(first, toWireValue(values))).toBe(true);
	});

	test("summarizes tables whose scalar fields exceed the traversal budget", () => {
		const rows = Array.from({ length: 3_000 }, () =>
			Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`field${index}`, index])),
		);
		expect(toWireValue(rows)).toEqual({ __observablejs_type__: "summary", value: "Array(3000)" });
	});

	test("summarizes oversized text and binary payloads", () => {
		expect(toWireValue("x".repeat(1_000_000))).toEqual({
			__observablejs_type__: "summary",
			value: "String(1000000)",
		});
		expect(toWireValue(new Uint8Array(1_000_000))).toEqual({
			__observablejs_type__: "summary",
			value: "Uint8Array(1000000 bytes)",
		});
	});
});
