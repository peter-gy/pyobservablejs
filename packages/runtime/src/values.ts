import { isCallable, isObjectValue } from "./value-kind";

export interface RuntimeObject {
	toString(): string;
}

export interface RuntimeRecord {
	[name: string]: RuntimeValue;
}

export type RuntimeValue =
	| null
	| undefined
	| boolean
	| number
	| bigint
	| string
	| symbol
	| RuntimeObject
	| RuntimeRecord;

export type Variables = Record<string, RuntimeValue>;

export function createVariableBuiltins(variables: Variables): Record<string, () => RuntimeValue> {
	// Observable invokes builtin definitions, including definitions that return functions.
	return Object.fromEntries(
		Object.entries(variables).map(([name, value]) => {
			// Runtime evaluates definitions asynchronously. Observe rejection now while
			// keeping the original promise available to dependency evaluation.
			if (value instanceof Promise) void Promise.prototype.then.call(value, undefined, () => undefined);
			return [name, () => value];
		}),
	);
}

type CompareContext = {
	left: WeakMap<object, object>;
	right: WeakMap<object, object>;
	nodes: number;
};

export function sameValue<Left, Right>(left: Left, right: Right): boolean {
	try {
		return compare(left, right, { left: new WeakMap(), right: new WeakMap(), nodes: 0 }, 0);
	} catch {
		return false;
	}
}

function compare<Left, Right>(left: Left, right: Right, context: CompareContext, depth: number): boolean {
	if (depth >= 100 || context.nodes++ >= 50_000) return false;
	if (!isObjectValue(left) || !isObjectValue(right) || isCallable(left) || isCallable(right))
		return Object.is(left, right);
	if (context.left.has(left) || context.right.has(right)) {
		return context.left.get(left) === right && context.right.get(right) === left;
	}
	context.left.set(left, right);
	context.right.set(right, left);
	if (Object.is(left, right)) return true;
	const prototype = Object.getPrototypeOf(left);
	if (prototype !== Object.getPrototypeOf(right)) return false;
	if (prototype === Date.prototype && left instanceof Date && right instanceof Date) {
		return Object.is(left.getTime(), right.getTime());
	}
	if (prototype === Map.prototype && left instanceof Map && right instanceof Map) {
		if (left.size !== right.size) return false;
		const rightEntries = right.entries();
		for (const [key, value] of left) {
			const other = rightEntries.next().value;
			if (!other || !compare(key, other[0], context, depth + 1) || !compare(value, other[1], context, depth + 1)) {
				return false;
			}
		}
		return true;
	}
	if (prototype === Set.prototype && left instanceof Set && right instanceof Set) {
		if (left.size !== right.size) return false;
		const rightValues = right.values();
		for (const value of left) {
			if (!compare(value, rightValues.next().value, context, depth + 1)) return false;
		}
		return true;
	}
	if (left instanceof ArrayBuffer && right instanceof ArrayBuffer) {
		if (prototype !== ArrayBuffer.prototype) return false;
		return sameBytes(left, right, context);
	}
	if (ArrayBuffer.isView(left) && ArrayBuffer.isView(right)) {
		if (
			prototype !== DataView.prototype &&
			Object.getPrototypeOf(prototype) !== Object.getPrototypeOf(Uint8Array.prototype)
		)
			return false;
		return sameBytes(left, right, context);
	}
	if (Array.isArray(left) && Array.isArray(right)) {
		if (prototype !== Array.prototype || left.length !== right.length) return false;
	} else if (prototype !== Object.prototype && prototype !== null) {
		return false;
	}
	const leftKeys = Reflect.ownKeys(left).filter((key) => Object.prototype.propertyIsEnumerable.call(left, key));
	const rightKeys = Reflect.ownKeys(right).filter((key) => Object.prototype.propertyIsEnumerable.call(right, key));
	if (leftKeys.length !== rightKeys.length) return false;
	for (const key of leftKeys) {
		const a = Object.getOwnPropertyDescriptor(left, key)!;
		const b = Object.getOwnPropertyDescriptor(right, key);
		if (!b?.enumerable || "value" in a !== "value" in b) return false;
		if ("value" in a) {
			if (!compare(a.value, b.value, context, depth + 1)) return false;
		} else if (a.get !== b.get || a.set !== b.set) {
			return false;
		}
	}
	return true;
}

function sameBytes(
	left: ArrayBuffer | ArrayBufferView,
	right: ArrayBuffer | ArrayBufferView,
	context: CompareContext,
): boolean {
	try {
		const a =
			left instanceof ArrayBuffer
				? new Uint8Array(left)
				: new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
		const b =
			right instanceof ArrayBuffer
				? new Uint8Array(right)
				: new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
		if (a.length !== b.length || context.nodes + a.length > 50_000) return false;
		context.nodes += a.length;
		for (let index = 0; index < a.length; index++) {
			if (a[index] !== b[index]) return false;
		}
		return true;
	} catch {
		return false;
	}
}
