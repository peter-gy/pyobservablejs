import { isBigInt, isBoolean, isCallable, isNumber, isObjectValue, isString, javaScriptKind } from "./value-kind";

const TYPE_KEY = "__observablejs_type__";

// anywidget traits carry JSON. __observablejs_type__ tags preserve values that
// need browser or Python revival.

type WireContext = {
	seen: WeakMap<object, number>;
	nextId: number;
	nodes: number;
};

const MAX_WIRE_DEPTH = 100;
const MAX_WIRE_NODES = 50_000;
const MAX_WIRE_COMPARE_NODES = 50_000;

type WireCompareContext = {
	seen: WeakMap<object, WeakSet<object>>;
	nodes: number;
};

export type WireValue = null | boolean | number | string | WireValue[] | WireRecord;

export interface WireRecord {
	[name: string]: WireValue | undefined;
}

export interface WireValues {
	[name: string]: WireValue;
}

export type RevivedValue =
	| undefined
	| null
	| boolean
	| number
	| string
	| bigint
	| Date
	| Uint8Array
	| RevivedValue[]
	| RevivedRecord
	| Map<RevivedValue, RevivedValue>
	| Set<RevivedValue>;

export interface RevivedRecord {
	[name: string]: RevivedValue;
}

export type VariableValue = RevivedValue | Promise<RevivedValue>;

export interface VariableBuiltins {
	[name: string]: () => VariableValue;
}

export function toWireValue<Value>(
	value: Value,
	context: WireContext = { seen: new WeakMap(), nextId: 1, nodes: 0 },
): WireValue {
	return toWireValueNode(value, context, 0);
}

function toWireValueNode<Value>(value: Value, context: WireContext, depth: number): WireValue {
	// Summarize live browser objects before trait sync attempts JSON cloning.
	if (value === undefined) return { [TYPE_KEY]: "undefined" };
	if (value === null || isBoolean(value) || isString(value)) return value;
	if (isNumber(value)) {
		if (Number.isFinite(value)) return value;
		if (Number.isNaN(value)) return { [TYPE_KEY]: "number", value: "NaN" };
		return { [TYPE_KEY]: "number", value: value > 0 ? "Infinity" : "-Infinity" };
	}
	if (isBigInt(value)) {
		return { [TYPE_KEY]: "bigint", value: value.toString() };
	}
	if (isCallable(value)) {
		return { [TYPE_KEY]: "function", value: value.name || "anonymous" };
	}
	if (value instanceof Date) {
		if (!isValidDate(value)) return { [TYPE_KEY]: "summary", value: "Invalid Date" };
		return { [TYPE_KEY]: "datetime", value: value.toISOString() };
	}
	if (value instanceof Element) {
		return { [TYPE_KEY]: "element", value: value.tagName.toLowerCase() };
	}
	if (value instanceof Error) {
		return { [TYPE_KEY]: "error", name: value.name, message: value.message };
	}
	if (value instanceof RegExp) {
		return { [TYPE_KEY]: "regexp", value: String(value) };
	}
	if (globalThis.File && value instanceof globalThis.File) {
		return { [TYPE_KEY]: "file", name: value.name, size: value.size, mimeType: value.type };
	}
	if (globalThis.Blob && value instanceof globalThis.Blob) {
		return { [TYPE_KEY]: "blob", size: value.size, mimeType: value.type };
	}
	if (value instanceof ArrayBuffer) {
		return arrayBufferWireValue(value);
	}
	if (ArrayBuffer.isView(value)) {
		return arrayBufferViewWireValue(value);
	}
	if (!isObjectValue(value)) return { [TYPE_KEY]: javaScriptKind(value), value: String(value) };
	if (depth >= MAX_WIRE_DEPTH || context.nodes >= MAX_WIRE_NODES) return summarizeWireValue(value);
	context.nodes += 1;
	if (Array.isArray(value)) {
		const ref = context.seen.get(value);
		if (ref !== undefined) return { [TYPE_KEY]: "reference", value: ref };
		context.seen.set(value, context.nextId++);
		const items: WireValue[] = [];
		for (let index = 0; index < value.length; index++) {
			items.push(toWireValueNode(value[index], context, depth + 1));
		}
		return items;
	}
	const ref = context.seen.get(value);
	if (ref !== undefined) return { [TYPE_KEY]: "reference", value: ref };
	context.seen.set(value, context.nextId++);
	if (value instanceof Map) {
		return {
			[TYPE_KEY]: "map",
			value: Array.from(value, ([key, item]) => [
				toWireValueNode(key, context, depth + 1),
				toWireValueNode(item, context, depth + 1),
			]),
		};
	}
	if (value instanceof Set) {
		return { [TYPE_KEY]: "set", value: Array.from(value, (item) => toWireValueNode(item, context, depth + 1)) };
	}
	const entries = Object.fromEntries(
		ownEnumerableDataEntries(value).map(([key, item]) => [key, toWireValueNode(item, context, depth + 1)]),
	);
	if (TYPE_KEY in entries) return { [TYPE_KEY]: "object", value: entries };
	return entries;
}

function summarizeWireValue<Value>(value: Value): WireRecord {
	if (Array.isArray(value)) return { [TYPE_KEY]: "summary", value: `Array(${value.length})` };
	if (value instanceof Map) return { [TYPE_KEY]: "summary", value: `Map(${value.size})` };
	if (value instanceof Set) return { [TYPE_KEY]: "summary", value: `Set(${value.size})` };
	if (isObjectValue(value)) {
		return { [TYPE_KEY]: "summary", value: constructorName(value, "Object") };
	}
	return { [TYPE_KEY]: "summary", value: javaScriptKind(value) };
}

function arrayBufferWireValue(value: ArrayBuffer): WireRecord {
	try {
		return { [TYPE_KEY]: "arraybuffer", value: bytesToBase64(new Uint8Array(value)) };
	} catch {
		return { [TYPE_KEY]: "summary", value: "ArrayBuffer(detached)" };
	}
}

function arrayBufferViewWireValue(value: ArrayBufferView): WireRecord {
	try {
		const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
		return {
			[TYPE_KEY]: "typedarray",
			name: constructorName(value, "ArrayBufferView"),
			value: bytesToBase64(bytes),
		};
	} catch {
		return { [TYPE_KEY]: "summary", value: `${constructorName(value, "ArrayBufferView")}(detached)` };
	}
}

function constructorName<Value extends object>(value: Value, fallback: string): string {
	const prototype = Object.getPrototypeOf(value);
	const descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, "constructor");
	const constructor = descriptor && "value" in descriptor ? descriptor.value : undefined;
	return isCallable(constructor) && constructor.name ? constructor.name : fallback;
}

export function reviveSyncedValue(value: WireValue | undefined): RevivedValue {
	// Cell traits store values used for `viewof` writes and isolated dependencies.
	if (Array.isArray(value)) return value.map(reviveSyncedValue);
	if (!isWireRecord(value)) return value;
	const type = value[TYPE_KEY];
	if (type === "undefined") return undefined;
	if (type === "number") return reviveNumber(String(value.value));
	if (type === "bigint") return BigInt(String(value.value));
	if (type === "datetime") return new Date(String(value.value));
	if (type === "object") return revivePlainObject(value.value);
	if (type === "map" && Array.isArray(value.value)) {
		const entries: Array<[RevivedValue, RevivedValue]> = [];
		for (const entry of value.value) {
			if (!Array.isArray(entry) || entry.length < 2) continue;
			entries.push([reviveSyncedValue(entry[0]), reviveSyncedValue(entry[1])]);
		}
		return new Map(entries);
	}
	if (type === "set" && Array.isArray(value.value)) return new Set(value.value.map(reviveSyncedValue));
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, reviveSyncedValue(item)]));
}

export function isWritableSyncedViewValue(value: WireValue | undefined): boolean {
	if (Array.isArray(value)) return value.every(isWritableSyncedViewValue);
	if (!isWireRecord(value)) return true;
	const type = value[TYPE_KEY];
	if (type === undefined) return Object.values(value).every(isWritableSyncedViewValue);
	if (type === "number" || type === "bigint" || type === "datetime") return true;
	if (type === "object") return isWritableSyncedViewValue(value.value);
	if (type === "map" || type === "set") {
		return Array.isArray(value.value) && value.value.every(isWritableSyncedViewValue);
	}
	return false;
}

export function sameWireValue<Left, Right>(left: Left, right: Right): boolean {
	return sameWireValueNode(left, right, { seen: new WeakMap(), nodes: 0 });
}

function sameWireValueNode<Left, Right>(left: Left, right: Right, context: WireCompareContext): boolean {
	if (Object.is(left, right)) return true;
	if (context.nodes++ > MAX_WIRE_COMPARE_NODES) return false;
	if (left === null || right === null) return false;
	if (javaScriptKind(left) !== javaScriptKind(right)) return false;
	if (!isObjectValue(left) || !isObjectValue(right)) return false;
	if (left instanceof Date || right instanceof Date) {
		return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
	}
	if (left instanceof RegExp || right instanceof RegExp) {
		return left instanceof RegExp && right instanceof RegExp && String(left) === String(right);
	}
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right)) return false;
		if (left.length !== right.length) return false;
		if (seenWirePair(left, right, context)) return true;
		for (let index = 0; index < left.length; index++) {
			if (!sameWireValueNode(left[index], right[index], context)) return false;
		}
		return true;
	}
	if (seenWirePair(left, right, context)) return true;
	const leftEntries = ownEnumerableDataEntries(left);
	const rightEntries = new Map(ownEnumerableDataEntries(right));
	const leftKeys = leftEntries.map(([key]) => key);
	const rightKeys = [...rightEntries.keys()];
	if (leftKeys.length !== rightKeys.length) return false;
	for (const [key, leftValue] of leftEntries) {
		if (!rightEntries.has(key)) return false;
		if (!sameWireValueNode(leftValue, rightEntries.get(key), context)) return false;
	}
	return true;
}

function ownEnumerableDataEntries<Value extends object>(value: Value): Array<[string, Value[keyof Value]]> {
	const entries: Array<[string, Value[keyof Value]]> = [];
	for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
		if (descriptor.enumerable && "value" in descriptor) entries.push([key, descriptor.value]);
	}
	return entries;
}

function seenWirePair<Left extends object, Right extends object>(
	left: Left,
	right: Right,
	context: WireCompareContext,
): boolean {
	const seenRight = context.seen.get(left);
	if (seenRight?.has(right)) return true;
	if (seenRight) seenRight.add(right);
	else context.seen.set(left, new WeakSet([right]));
	return false;
}

export function createVariableBuiltins(variables: WireValues): VariableBuiltins {
	// Observable builtins are thunks. Cache revived Python values per variable.
	const builtins: VariableBuiltins = {};
	const cache = new Map<string, VariableValue>();
	for (const [name, value] of Object.entries(variables)) {
		builtins[name] = () => {
			if (!cache.has(name)) cache.set(name, revivePythonValue(value));
			return cache.get(name);
		};
	}
	return builtins;
}

export function revivePythonValue(value: WireValue | undefined): VariableValue {
	if (Array.isArray(value)) {
		return resolveMaybePromises(value.map(revivePythonValue), (items) => items);
	}
	if (!isWireRecord(value)) return value;

	const type = value[TYPE_KEY];
	if (type === "datetime") return new Date(String(value.value));
	if (type === "bytes") return base64ToBytes(String(value.value));
	if (type === "number") return reviveNumber(String(value.value));
	if (type === "bigint") return BigInt(String(value.value));
	if (type === "object") return revivePlainPythonObject(value.value);

	const entries = Object.entries(value).map(([key, entry]) => [key, revivePythonValue(entry)] as const);
	return resolveMaybePromises(
		entries.map(([, entry]) => entry),
		(items) => Object.fromEntries(entries.map(([key], index) => [key, items[index]])) satisfies RevivedRecord,
	);
}

function resolveMaybePromises<Result extends RevivedValue>(
	values: VariableValue[],
	finish: (values: RevivedValue[]) => Result,
): Result | Promise<Result> {
	if (!areRevivedValues(values)) return Promise.all(values.map((value) => Promise.resolve(value))).then(finish);
	return finish(values);
}

function revivePlainObject(value: WireValue | undefined): RevivedValue {
	if (!isWireRecord(value)) return reviveSyncedValue(value);
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, reviveSyncedValue(item)]));
}

function revivePlainPythonObject(value: WireValue | undefined): VariableValue {
	if (!isWireRecord(value)) return revivePythonValue(value);
	const entries = Object.entries(value).map(([key, entry]) => [key, revivePythonValue(entry)] as const);
	return resolveMaybePromises(
		entries.map(([, entry]) => entry),
		(items) => Object.fromEntries(entries.map(([key], index) => [key, items[index]])) satisfies RevivedRecord,
	);
}

function isWireRecord<Value>(value: Value): value is Value & WireRecord {
	return isObjectValue(value) && !isCallable(value) && !Array.isArray(value);
}

function isPromiseLike<Value>(value: Value): value is Value & PromiseLike<RevivedValue> {
	return isObjectValue(value) && "then" in value && isCallable(value.then);
}

function areRevivedValues(values: VariableValue[]): values is RevivedValue[] {
	return values.every((value) => !isPromiseLike(value));
}

function reviveNumber(value: string): number {
	if (value === "NaN") return Number.NaN;
	if (value === "Infinity") return Number.POSITIVE_INFINITY;
	if (value === "-Infinity") return Number.NEGATIVE_INFINITY;
	return Number(value);
}

function base64ToBytes(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

function bytesToBase64(value: Uint8Array): string {
	let binary = "";
	for (const byte of value) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function isValidDate<Value>(value: Value): value is Value & Date {
	return value instanceof Date && Number.isFinite(value.getTime());
}
