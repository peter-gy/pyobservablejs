import type { RuntimeValue } from "@pyobservablejs/runtime";
import { expect, test, vi } from "vite-plus/test";
import { readResponse, reviveSyncedValue } from "@pyobservablejs/protocol";

function exact(data: RuntimeValue) {
	const response = readResponse({ cell: 0, name: "value", revision: 1, format: "native", data }, "json");
	if (!("data" in response.result)) throw new Error("Expected an exact JSON response");
	return response.result.data;
}

interface CyclicValue {
	self?: CyclicValue;
}

test.each([
	["function", () => () => 1],
	["DOM element", () => document.createElement("div")],
	["binary", () => new Uint8Array([1, 2])],
	["array metadata", () => Object.assign([1, 2], { columns: ["value"] })],
	["fractional array property", () => Object.assign([1], { "0.5": 2 })],
	["symbol property", () => ({ [Symbol("field")]: 3 })],
	[
		"cycle",
		() => {
			const value: CyclicValue = {};
			value.self = value;
			return value;
		},
	],
] as const)("exact reads reject %s instead of losing information", (_name, makeValue) => {
	expect(() => exact(makeValue())).toThrow("Use Arrow, attachment bytes, or a smaller projection");
});

test("exact reads reject accessors without invoking them", () => {
	const getter = vi.fn(() => 42);
	const value = Object.defineProperty({}, "answer", { enumerable: true, get: getter });
	expect(() => exact(value)).toThrow("cannot be read exactly");
	expect(getter).not.toHaveBeenCalled();
});

test("exact reads preserve reserved names, scalar tags, shared branches and sparse arrays", () => {
	const shared = Object.assign(Object.create(null), { __observablejs_type__: "summary", value: "authored" });
	const value = {
		shared,
		map: new Map([["key", shared]]),
		set: new Set([shared]),
		date: new Date("2026-09-17T00:00:00.000Z"),
		integer: 9007199254740993n,
		numbers: [NaN, Infinity, -Infinity, -0],
		sparse: Array.from({ length: 2 }),
	};
	expect(reviveSyncedValue(JSON.parse(JSON.stringify(exact(value))))).toEqual(value);
	const sparse: number[] = [];
	sparse.length = 2;
	expect(reviveSyncedValue(exact(sparse))).toEqual([undefined, undefined]);
});

test("exact reads enforce their budget while expanding shared branches", () => {
	const sparse: number[] = [];
	sparse.length = 5_000;
	expect(() => exact(Array.from({ length: 101 }, () => sparse))).toThrow("cannot be read exactly");
	expect(() => exact("x".repeat(3_000_000))).toThrow("cannot be read exactly");
});

test("exact reads reject custom prototypes instead of discarding their behavior", () => {
	class CustomRecord {
		value = 42;
	}
	class CustomDate extends Date {}
	expect(() => exact(new CustomRecord())).toThrow("cannot be read exactly");
	expect(() => exact(new CustomDate("2026-09-17"))).toThrow("cannot be read exactly");
});
