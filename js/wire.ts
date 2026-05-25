const ARROW_URL = "https://cdn.jsdelivr.net/npm/apache-arrow@17.0.0/+esm";

// anywidget traits carry JSON. __observablejs_type__ tags preserve values that
// need browser or Python revival.

type WireContext = {
	seen: WeakMap<object, number>;
	nextId: number;
};

export function toWireValue(value: unknown, context: WireContext = { seen: new WeakMap(), nextId: 1 }): unknown {
	// Summarize live browser objects before trait sync attempts JSON cloning.
	if (value === undefined) return { __observablejs_type__: "undefined" };
	if (value === null || typeof value === "boolean" || typeof value === "string") return value;
	if (typeof value === "number") {
		if (Number.isFinite(value)) return value;
		if (Number.isNaN(value)) return { __observablejs_type__: "number", value: "NaN" };
		return { __observablejs_type__: "number", value: value > 0 ? "Infinity" : "-Infinity" };
	}
	if (typeof value === "bigint") {
		return { __observablejs_type__: "bigint", value: value.toString() };
	}
	if (typeof value === "function") {
		return { __observablejs_type__: "function", value: value.name || "anonymous" };
	}
	if (value instanceof Date) {
		return { __observablejs_type__: "datetime", value: value.toISOString() };
	}
	if (value instanceof Element) {
		return { __observablejs_type__: "element", value: value.tagName.toLowerCase() };
	}
	if (value instanceof Error) {
		return { __observablejs_type__: "error", name: value.name, message: value.message };
	}
	if (value instanceof RegExp) {
		return { __observablejs_type__: "regexp", value: String(value) };
	}
	if (typeof File !== "undefined" && value instanceof File) {
		return { __observablejs_type__: "file", name: value.name, size: value.size, mimeType: value.type };
	}
	if (typeof Blob !== "undefined" && value instanceof Blob) {
		return { __observablejs_type__: "blob", size: value.size, mimeType: value.type };
	}
	if (value instanceof ArrayBuffer) {
		return { __observablejs_type__: "arraybuffer", value: bytesToBase64(new Uint8Array(value)) };
	}
	if (ArrayBuffer.isView(value)) {
		const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
		return {
			__observablejs_type__: "typedarray",
			name: value.constructor.name,
			value: bytesToBase64(bytes),
		};
	}
	if (Array.isArray(value)) {
		const ref = context.seen.get(value);
		if (ref !== undefined) return { __observablejs_type__: "reference", value: ref };
		context.seen.set(value, context.nextId++);
		return value.map((item) => toWireValue(item, context));
	}
	if (isRecord(value)) {
		const ref = context.seen.get(value);
		if (ref !== undefined) return { __observablejs_type__: "reference", value: ref };
		context.seen.set(value, context.nextId++);
		if (value instanceof Map) {
			return {
				__observablejs_type__: "map",
				value: Array.from(value, ([key, item]) => [toWireValue(key, context), toWireValue(item, context)]),
			};
		}
		if (value instanceof Set) {
			return { __observablejs_type__: "set", value: Array.from(value, (item) => toWireValue(item, context)) };
		}
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toWireValue(item, context)]));
	}
	return { __observablejs_type__: typeof value, value: String(value) };
}

export function reviveSyncedValue(value: unknown): unknown {
	// Cell traits store values used for `viewof` writes and isolated dependencies.
	if (Array.isArray(value)) return value.map(reviveSyncedValue);
	if (!isRecord(value)) return value;
	const type = value.__observablejs_type__;
	if (type === "undefined") return undefined;
	if (type === "number") return reviveNumber(String(value.value));
	if (type === "bigint") return BigInt(String(value.value));
	if (type === "datetime") return new Date(String(value.value));
	if (type === "object") return reviveSyncedValue(value.value);
	if (type === "map" && Array.isArray(value.value)) {
		return new Map(value.value.map((entry) => (Array.isArray(entry) ? entry.map(reviveSyncedValue) : entry)));
	}
	if (type === "set" && Array.isArray(value.value)) return new Set(value.value.map(reviveSyncedValue));
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, reviveSyncedValue(item)]));
}

export function sameWireValue(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
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
	// Browser half of src/observablejs/_variables.py for the synced `_data` trait.
	if (Array.isArray(value)) {
		return resolveMaybePromises(value.map(revivePythonValue), (items) => items);
	}
	if (!isRecord(value)) return value;

	const type = value.__observablejs_type__;
	if (type === "datetime") return new Date(String(value.value));
	if (type === "bytes") return base64ToBytes(String(value.value));
	if (type === "arrow") return reviveArrowTable(String(value.value));
	if (type === "number") return reviveNumber(String(value.value));
	if (type === "object") return revivePythonValue(value.value);

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

async function reviveArrowTable(value: string): Promise<unknown> {
	const Arrow = (await import(/* @vite-ignore */ ARROW_URL)) as { tableFromIPC(data: Uint8Array): unknown };
	return Arrow.tableFromIPC(base64ToBytes(value));
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
