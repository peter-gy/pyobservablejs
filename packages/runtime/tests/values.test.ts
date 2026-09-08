import { describe, expect, test } from "vite-plus/test";
import { createVariableBuiltins, sameValue } from "../src/values";
import { writeViewValue } from "../src/views";

interface CyclicValue {
	self?: CyclicValue;
	value: number;
}

interface NestedValue {
	next?: NestedValue;
}

describe("native values", () => {
	test("preserves native variable identities through Observable builtin definitions", () => {
		const values = {
			format: (value: number) => String(value),
			when: new Date("2026-05-23"),
			lookup: new Map([["a", 1]]),
			items: new Set([1, 2]),
			bytes: new Uint8Array([1, 2]),
			element: document.createElement("div"),
			pending: Promise.resolve(1),
		};
		const builtins = createVariableBuiltins(values);

		for (const [name, value] of Object.entries(values)) {
			expect(builtins[name]!()).toBe(value);
		}
	});

	test("compares native data structures by contents", () => {
		const data = () => ({
			when: new Date("2026-05-23"),
			lookup: new Map([[{ id: 1 }, new Set([2, 3])]]),
			bytes: new Uint8Array([1, 2]),
			buffer: new Uint8Array([3, 4]).buffer,
			values: [null, undefined, Number.NaN, 1n],
		});

		expect(sameValue(data(), data())).toBe(true);
		expect(sameValue(new Map([["a", 1]]), new Map([["a", 2]]))).toBe(false);
		expect(sameValue(new Set([1]), new Set([2]))).toBe(false);
		expect(sameValue(new Uint8Array([1]), new Uint8Array([2]))).toBe(false);
		expect(sameValue(new Uint8Array([1]), new Int8Array([1]))).toBe(false);
		expect(sameValue({ value: 0 }, { value: -0 })).toBe(false);
	});

	test("uses identity for callable, DOM, symbol, and class values", () => {
		class Value {}
		for (const [left, right] of [
			[() => 1, () => 1],
			[document.createElement("div"), document.createElement("div")],
			[Symbol("value"), Symbol("value")],
			[new Value(), new Value()],
			[Promise.resolve(1), Promise.resolve(1)],
		]) {
			expect(sameValue(left, left)).toBe(true);
			expect(sameValue(left, right)).toBe(false);
		}
	});

	test("compares cyclic data and preserves reference topology", () => {
		const left: CyclicValue = { value: 1 };
		left.self = left;
		const right: CyclicValue = { value: 1 };
		right.self = right;

		expect(sameValue(left, right)).toBe(true);
		right.value = 2;
		expect(sameValue(left, right)).toBe(false);
		const shared = {};
		expect(sameValue([shared, shared], [{}, {}])).toBe(false);
		expect(sameValue([shared, shared], [shared, {}])).toBe(false);
	});

	test("bounds deep comparison and avoids invoking accessors", () => {
		let reads = 0;
		const left = {
			get value() {
				reads++;
				return 1;
			},
		};
		const right = {
			get value() {
				reads++;
				return 1;
			},
		};
		expect(sameValue(left, right)).toBe(false);
		expect(reads).toBe(0);
		let a: NestedValue = {};
		let b: NestedValue = {};
		for (let index = 0; index < 1_000; index++) {
			a = { next: a };
			b = { next: b };
		}
		expect(sameValue(a, b)).toBe(false);
	});

	test("returns unsupported when invalid dates target date inputs", () => {
		const input = document.createElement("input");
		input.type = "date";

		expect(writeViewValue(input, new Date(Number.NaN))).toBe("unsupported");
		expect(input.value).toBe("");
	});

	test("writes native object values to custom view controls", () => {
		const input = Object.assign(new EventTarget(), { value: new Map([["a", 1]]) });
		const value = new Map([["a", 2]]);

		expect(writeViewValue(input, value)).toBe("applied");
		expect(input.value).toBe(value);
	});
});
