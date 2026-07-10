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

export function toWireValue(
	value: unknown,
	context: WireContext = { seen: new WeakMap(), nextId: 1, nodes: 0 },
): unknown {
	return toWireValueNode(value, context, 0);
}

function toWireValueNode(value: unknown, context: WireContext, depth: number): unknown {
	// Summarize live browser objects before trait sync attempts JSON cloning.
	if (value === undefined) return { [TYPE_KEY]: "undefined" };
	if (value === null || typeof value === "boolean" || typeof value === "string") return value;
	if (typeof value === "number") {
		if (Number.isFinite(value)) return value;
		if (Number.isNaN(value)) return { [TYPE_KEY]: "number", value: "NaN" };
		return { [TYPE_KEY]: "number", value: value > 0 ? "Infinity" : "-Infinity" };
	}
	if (typeof value === "bigint") {
		return { [TYPE_KEY]: "bigint", value: value.toString() };
	}
	if (typeof value === "function") {
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
	if (typeof File !== "undefined" && value instanceof File) {
		return { [TYPE_KEY]: "file", name: value.name, size: value.size, mimeType: value.type };
	}
	if (typeof Blob !== "undefined" && value instanceof Blob) {
		return { [TYPE_KEY]: "blob", size: value.size, mimeType: value.type };
	}
	if (value instanceof ArrayBuffer) {
		return arrayBufferWireValue(value);
	}
	if (ArrayBuffer.isView(value)) {
		return arrayBufferViewWireValue(value);
	}
	if (depth >= MAX_WIRE_DEPTH || context.nodes >= MAX_WIRE_NODES) return summarizeWireValue(value);
	context.nodes += 1;
	if (Array.isArray(value)) {
		const ref = context.seen.get(value);
		if (ref !== undefined) return { [TYPE_KEY]: "reference", value: ref };
		context.seen.set(value, context.nextId++);
		const items: unknown[] = [];
		for (let index = 0; index < value.length; index++) {
			items.push(toWireValueNode(value[index], context, depth + 1));
		}
		return items;
	}
	if (isRecord(value)) {
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
	return { [TYPE_KEY]: typeof value, value: String(value) };
}

function summarizeWireValue(value: unknown): Record<string, string> {
	if (Array.isArray(value)) return { [TYPE_KEY]: "summary", value: `Array(${value.length})` };
	if (value instanceof Map) return { [TYPE_KEY]: "summary", value: `Map(${value.size})` };
	if (value instanceof Set) return { [TYPE_KEY]: "summary", value: `Set(${value.size})` };
	if (value !== null && typeof value === "object") {
		return { [TYPE_KEY]: "summary", value: constructorName(value, "Object") };
	}
	return { [TYPE_KEY]: "summary", value: typeof value };
}

function arrayBufferWireValue(value: ArrayBuffer): Record<string, unknown> {
	try {
		return { [TYPE_KEY]: "arraybuffer", value: bytesToBase64(new Uint8Array(value)) };
	} catch {
		return { [TYPE_KEY]: "summary", value: "ArrayBuffer(detached)" };
	}
}

function arrayBufferViewWireValue(value: ArrayBufferView): Record<string, unknown> {
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

function constructorName(value: object, fallback: string): string {
	const prototype = Object.getPrototypeOf(value);
	const descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, "constructor");
	const constructor = descriptor && "value" in descriptor ? descriptor.value : undefined;
	return typeof constructor === "function" && constructor.name ? constructor.name : fallback;
}

export function reviveSyncedValue(value: unknown): unknown {
	// Cell traits store values used for `viewof` writes and isolated dependencies.
	if (Array.isArray(value)) return value.map(reviveSyncedValue);
	if (!isRecord(value)) return value;
	const type = value[TYPE_KEY];
	if (type === "undefined") return undefined;
	if (type === "number") return reviveNumber(String(value.value));
	if (type === "bigint") return BigInt(String(value.value));
	if (type === "datetime") return new Date(String(value.value));
	if (type === "object") return revivePlainObject(value.value);
	if (type === "map" && Array.isArray(value.value)) {
		return new Map(value.value.map((entry) => (Array.isArray(entry) ? entry.map(reviveSyncedValue) : entry)));
	}
	if (type === "set" && Array.isArray(value.value)) return new Set(value.value.map(reviveSyncedValue));
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, reviveSyncedValue(item)]));
}

export function isWritableSyncedViewValue(value: unknown): boolean {
	if (Array.isArray(value)) return value.every(isWritableSyncedViewValue);
	if (!isRecord(value)) return true;
	const type = value[TYPE_KEY];
	if (type === undefined) return Object.values(value).every(isWritableSyncedViewValue);
	if (type === "number" || type === "bigint" || type === "datetime") return true;
	if (type === "object") return isWritableSyncedViewValue(value.value);
	if (type === "map" || type === "set") {
		return Array.isArray(value.value) && value.value.every(isWritableSyncedViewValue);
	}
	return false;
}

export function sameWireValue(left: unknown, right: unknown): boolean {
	return sameWireValueNode(left, right, { seen: new WeakMap(), nodes: 0 });
}

function sameWireValueNode(left: unknown, right: unknown, context: WireCompareContext): boolean {
	if (Object.is(left, right)) return true;
	if (context.nodes++ > MAX_WIRE_COMPARE_NODES) return false;
	if (left === null || right === null) return false;
	if (typeof left !== typeof right) return false;
	if (typeof left !== "object" || typeof right !== "object") return false;
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
	if (!isRecord(left) || !isRecord(right)) return false;
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

function ownEnumerableDataEntries(value: object): Array<[string, unknown]> {
	return Object.entries(Object.getOwnPropertyDescriptors(value)).flatMap(([key, descriptor]) =>
		descriptor.enumerable && "value" in descriptor ? [[key, descriptor.value]] : [],
	);
}

function seenWirePair(left: object, right: object, context: WireCompareContext): boolean {
	const seenRight = context.seen.get(left);
	if (seenRight?.has(right)) return true;
	if (seenRight) seenRight.add(right);
	else context.seen.set(left, new WeakSet([right]));
	return false;
}

export function createVariableBuiltins(variables: Record<string, unknown>): Record<string, () => unknown> {
	// Observable builtins are thunks. Cache revived Python values per variable.
	const builtins: Record<string, () => unknown> = {};
	const cache = new Map<string, unknown>();
	for (const [name, value] of Object.entries(variables)) {
		builtins[name] = () => {
			if (!cache.has(name)) cache.set(name, revivePythonValue(value));
			return cache.get(name);
		};
	}
	return builtins;
}

export function revivePythonValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return resolveMaybePromises(value.map(revivePythonValue), (items) => items);
	}
	if (!isRecord(value)) return value;

	const type = value[TYPE_KEY];
	if (type === "datetime") return new Date(String(value.value));
	if (type === "bytes") return base64ToBytes(String(value.value));
	if (type === "number") return reviveNumber(String(value.value));
	if (type === "bigint") return BigInt(String(value.value));
	if (type === "object") return revivePlainPythonObject(value.value);

	const entries = Object.entries(value).map(([key, entry]) => [key, revivePythonValue(entry)] as const);
	return resolveMaybePromises(
		entries.map(([, entry]) => entry),
		(items) => Object.fromEntries(entries.map(([key], index) => [key, items[index]])),
	);
}

function resolveMaybePromises<T>(values: unknown[], finish: (values: unknown[]) => T): T | Promise<T> {
	if (values.some(isPromiseLike)) return Promise.all(values).then(finish);
	return finish(values);
}

function revivePlainObject(value: unknown): unknown {
	if (!isRecord(value)) return reviveSyncedValue(value);
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, reviveSyncedValue(item)]));
}

function revivePlainPythonObject(value: unknown): unknown {
	if (!isRecord(value)) return revivePythonValue(value);
	const entries = Object.entries(value).map(([key, entry]) => [key, revivePythonValue(entry)] as const);
	return resolveMaybePromises(
		entries.map(([, entry]) => entry),
		(items) => Object.fromEntries(entries.map(([key], index) => [key, items[index]])),
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return isRecord(value) && typeof value.then === "function";
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

function isValidDate(value: unknown): value is Date {
	return value instanceof Date && Number.isFinite(value.getTime());
}
