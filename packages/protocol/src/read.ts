import { createDiagnostic, DiagnosticError, type DiagnosticOrigin } from "@pyobservablejs/runtime/diagnostics";
import type { NotebookRead, ReadSelector, ReadOptions } from "@pyobservablejs/runtime";
import {
	javaScriptKind,
	isBigInt,
	isBoolean,
	isCallable,
	isNumber,
	isObjectValue,
	isString,
	isSymbol,
} from "@pyobservablejs/runtime/values";
import type { WireValue, WireRecord } from "./values";
type ReadResult = NotebookRead;
export type WireReadFormat = "json" | "rows" | "arrow" | "bytes" | "html";
type WireReadOptions = Omit<ReadOptions, "format"> & { format: WireReadFormat | "python" };
export type WireRead = Omit<ReadResult, "data" | "format"> & { format: WireReadFormat } & (
		| { binary: true }
		| { data: WireValue }
	);
type ReadResponse = { result: WireRead; buffers: DataView[] };
const TYPE_KEY = "__observablejs_type__";
export function isRecord(value: WireValue | undefined): value is WireRecord {
	return isObjectValue(value) && !Array.isArray(value);
}
export function readSelector(value: WireValue | undefined): ReadSelector {
	if (isString(value) && value) return value;
	if (!isRecord(value)) throw new TypeError("Read selector must identify a variable, cell, or attachment");
	if (isString(value.attachment) && value.attachment) return { attachment: value.attachment };
	const path = value.path === undefined ? undefined : readPath(value.path);
	const name = value.name;
	if (name !== undefined && name !== null && (!isString(name) || !name))
		throw new TypeError("Read name must be a non-empty string or null");
	if (value.cell !== undefined) return { cell: nonNegativeInteger(value.cell, "cell"), name, path };
	if (isString(name)) return { name, path };
	throw new TypeError("Read selector must identify a variable, cell, or attachment");
}

function readPath(value: WireValue): (string | number)[] {
	if (!Array.isArray(value)) throw new TypeError("Read path must be an array of property names or indexes");
	return value.map((part) => {
		if (isString(part) || (isNumber(part) && Number.isFinite(part))) return part;
		throw new TypeError("Read path must contain property names or numeric indexes");
	});
}

function nonNegativeInteger(value: WireValue, name: string): number {
	if (!isNumber(value) || !Number.isSafeInteger(value) || value < 0)
		throw new TypeError(`${name} must be a non-negative integer`);
	return value;
}

export function readOptions(value: WireValue | undefined): WireReadOptions {
	if (value === undefined) return { format: "json" };
	if (!isRecord(value)) throw new TypeError("Read options must be an object");
	const options: WireReadOptions = { format: "json" };
	if (value.format !== undefined) {
		if (
			value.format !== "json" &&
			value.format !== "rows" &&
			value.format !== "arrow" &&
			value.format !== "bytes" &&
			value.format !== "html" &&
			value.format !== "python"
		) {
			throw new TypeError("Python reads require python, json, rows, arrow, bytes, or html format");
		}
		options.format = value.format;
	}
	for (const name of ["offset", "limit", "revision"] as const) {
		if (value[name] !== undefined) options[name] = nonNegativeInteger(value[name], name);
	}
	if (value.columns !== undefined) {
		if (!Array.isArray(value.columns) || !value.columns.every(isString))
			throw new TypeError("Read columns must be an array of names");
		options.columns = value.columns;
	}
	return options;
}

export function readResponse(value: ReadResult, format: WireReadFormat): ReadResponse {
	const { data, format: _format, ...metadata } = value;
	if (format === "arrow" || format === "bytes") {
		if (!(data instanceof Uint8Array)) throw new TypeError("Binary reads must return a Uint8Array");
		const bytes = new Uint8Array(data);
		return { result: { ...metadata, format, binary: true }, buffers: [new DataView(bytes.buffer)] };
	}
	return { result: { ...metadata, format, data: encodeReadValue(data) }, buffers: [] };
}

function encodeReadValue<Value>(value: Value): WireValue {
	return encodeExactValue(value, { nodes: 500_000, bytes: 16 * 1024 * 1024, ancestors: new WeakSet() });
}

type ReadShapeBudget = { nodes: number; bytes: number; ancestors: WeakSet<object> };

function consumeReadBudget(budget: ReadShapeBudget, nodes: number, bytes: number): void {
	budget.nodes -= nodes;
	budget.bytes -= bytes;
	if (budget.nodes < 0 || budget.bytes < 0) throw readShapeError();
}

function taggedReadValue(budget: ReadShapeBudget, tag: string, value?: WireValue): WireRecord {
	consumeReadBudget(budget, value === undefined ? 1 : 2, 128 + tag.length * 6);
	if (isString(value)) consumeReadBudget(budget, 0, value.length * 6);
	return value === undefined ? { [TYPE_KEY]: tag } : { [TYPE_KEY]: tag, value };
}

function encodeExactValue<Value>(value: Value, budget: ReadShapeBudget, depth = 0): WireValue {
	consumeReadBudget(budget, 1, isString(value) ? 32 + value.length * 6 : 32);
	if (depth >= 100 || isCallable(value) || isSymbol(value)) throw readShapeError();
	if (value === undefined) return taggedReadValue(budget, "undefined");
	if (value === null || isString(value) || isBoolean(value)) return value;
	if (isNumber(value)) {
		if (Object.is(value, -0)) return taggedReadValue(budget, "number", "-0");
		return Number.isFinite(value) ? value : taggedReadValue(budget, "number", String(value));
	}
	if (isBigInt(value)) return taggedReadValue(budget, "bigint", String(value));
	if (!isObjectValue(value)) throw readShapeError();
	const prototype = Object.getPrototypeOf(value);
	if (prototype === Date.prototype && value instanceof Date) {
		if (Reflect.ownKeys(value).length || !Number.isFinite(value.getTime())) throw readShapeError();
		return taggedReadValue(budget, "datetime", value.toISOString());
	}
	// Only the active path is cyclic. Repeated branches are encoded independently,
	// without preview summaries or a temporary clone of the complete source value.
	if (budget.ancestors.has(value)) throw readShapeError();
	budget.ancestors.add(value);
	try {
		if (prototype === Map.prototype && value instanceof Map) {
			if (Reflect.ownKeys(value).length || value.size * 2 > budget.nodes) throw readShapeError();
			const entries: WireValue[] = [];
			for (const [key, item] of value) {
				entries.push([encodeExactValue(key, budget, depth + 1), encodeExactValue(item, budget, depth + 1)]);
			}
			return taggedReadValue(budget, "map", entries);
		}
		if (prototype === Set.prototype && value instanceof Set) {
			if (Reflect.ownKeys(value).length || value.size > budget.nodes) throw readShapeError();
			const items: WireValue[] = [];
			for (const item of value) items.push(encodeExactValue(item, budget, depth + 1));
			return taggedReadValue(budget, "set", items);
		}
		const array = Array.isArray(value);
		if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
			throw readShapeError();
		if (array && value.length > budget.nodes) throw readShapeError();
		const keys = Reflect.ownKeys(value);
		if (array) {
			for (const key of keys) {
				if (key === "length") continue;
				if (
					!isString(key) ||
					!Number.isInteger(Number(key)) ||
					String(Number(key)) !== key ||
					Number(key) < 0 ||
					Number(key) >= value.length
				)
					throw readShapeError();
			}
			const items: WireValue[] = [];
			for (let index = 0; index < value.length; index++) {
				const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
				if (descriptor && (!descriptor.enumerable || !("value" in descriptor))) throw readShapeError();
				items.push(encodeExactValue(descriptor?.value, budget, depth + 1));
			}
			return items;
		}
		const entries: WireRecord = {};
		for (const key of keys) {
			if (!isString(key)) throw readShapeError();
			consumeReadBudget(budget, 1, key.length * 6);
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor?.enumerable || !("value" in descriptor)) throw readShapeError();
			Object.defineProperty(entries, key, {
				value: encodeExactValue(descriptor.value, budget, depth + 1),
				enumerable: true,
				configurable: true,
				writable: true,
			});
		}
		return TYPE_KEY in entries ? taggedReadValue(budget, "object", entries) : entries;
	} finally {
		budget.ancestors.delete(value);
	}
}

function readShapeError(): TypeError {
	return new TypeError(
		"This value cannot be read exactly as JSON. Use Arrow, attachment bytes, or a smaller projection",
	);
}

export async function executeRead(
	notebook: { read(selector: ReadSelector, options: ReadOptions): Promise<NotebookRead> },
	selector: ReadSelector,
	options: WireReadOptions,
	signal: AbortSignal,
	origin: DiagnosticOrigin,
): Promise<ReadResponse> {
	const { format, ...parameters } = options;
	let result = await notebook.read(selector, {
		...parameters,
		signal,
		format: format === "json" || format === "python" ? "native" : format,
	});
	let output: WireReadFormat = format === "python" ? "json" : format;

	if (format === "python") {
		const data = result.data;
		if (data instanceof ArrayBuffer || data instanceof Uint8Array || data instanceof DataView) {
			output = "bytes";
			result = {
				...result,
				data:
					data instanceof ArrayBuffer
						? new Uint8Array(data)
						: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
			};
		} else if (ArrayBuffer.isView(data) && "length" in data && isNumber(data.length)) {
			output = "json";
			// SAFETY: ArrayBuffer.isView excludes proxies, and DataView was handled above.
			const array = data as typeof data & ArrayLike<number | bigint>;
			result = { ...result, data: Array.from(array) };
		} else if (result.dataset && result.dataset.kind !== "array") {
			output = "rows";
			result = await notebook.read(selector, { ...parameters, signal, revision: result.revision, format: "rows" });
		} else output = "json";
	}
	try {
		return readResponse(result, output);
	} catch (cause) {
		throw new DiagnosticError(
			createDiagnostic(cause, {
				origin,
				phase: "serialization",
				component: "packages/protocol/src/read.ts",
				operation: "serialize read value",
			}),
		);
	}
}

export function describeResponse(value: NotebookRead) {
	return { kind: javaScriptKind(value.data), dataset: value.dataset ?? null };
}
