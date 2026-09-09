import { createDiagnostic, type Diagnostic, type MountedNotebook } from "@pyobservablejs/runtime";
import {
	isBigInt,
	isBoolean,
	isCallable,
	isNumber,
	isObjectValue,
	isString,
	isSymbol,
} from "@pyobservablejs/runtime/values";
import { isRecord, type AnyWidgetModel, type WidgetModel, type WireDiagnostics } from "./model";
import { toWireValue, type RevivedRecord, type RevivedValue, type WireValue } from "./values";

type NotebookAccess = Pick<MountedNotebook, "inspection" | "datasets" | "read">;
type ReadSelector = Parameters<NotebookAccess["read"]>[0];
type ReadOptions = NonNullable<Parameters<NotebookAccess["read"]>[1]>;
type ReadResult = Awaited<ReturnType<NotebookAccess["read"]>>;
type WireReadFormat = "json" | "rows" | "arrow" | "bytes";
type WireReadOptions = Omit<ReadOptions, "format"> & { format: WireReadFormat };
type WireRead = Omit<ReadResult, "data" | "format"> & { format: WireReadFormat } & (
		| { binary: true }
		| { data: WireValue }
	);
export type ReadySnapshot = { readback: NonNullable<WidgetModel["_readback"]>; diagnostics: WireDiagnostics };
type ResponseBody =
	| { result: WireRead | (ReadySnapshot & { ready: true }) }
	| { error: Diagnostic; diagnostics?: WireDiagnostics };
type ReadResponse = { result: WireRead; buffers: DataView[] };
type Request = {
	id: string;
	generation: string;
	params: Record<string, WireValue | undefined>;
};

const envelope = { kind: "observablejs:access", protocol: 1 } as const;
const exactTags = new Set(["undefined", "number", "bigint", "datetime", "map", "set"]);

export function connectRequests(
	model: AnyWidgetModel,
	notebook: NotebookAccess,
	signal: AbortSignal,
	options?: {
		onError(cause: unknown, operation: string): void;
		ready(sequence: number, signal: AbortSignal): Promise<void>;
		checkpoint(): ReadySnapshot;
	},
): () => void {
	if (signal.aborted) return () => {};
	const generation = crypto.getRandomValues(new Uint32Array(4)).join("-");
	const pending = new Map<string, AbortController>();
	const publishDatasets = () => {
		if (signal.aborted) return;
		try {
			if (model.get("_inspection")?.generation !== generation) return;
			model.set("_datasets", { generation, values: notebook.datasets });
			model.save_changes();
		} catch (cause) {
			options?.onError(cause, "publish dataset metadata");
		}
	};
	const respond = (request: Request, body: ResponseBody, buffers: DataView[] = []) => {
		try {
			model.send(
				{ ...envelope, type: "response", id: request.id, generation: request.generation, ...body },
				undefined,
				buffers,
			);
		} catch (cause) {
			options?.onError(cause, "send response");
		}
	};
	const execute = async (request: Request, controller: AbortController) => {
		let phase: Diagnostic["phase"] = "transport";
		let operation = request.params.operation === "ready" ? "wait for view" : "read value";
		const active = () => !signal.aborted && !controller.signal.aborted && pending.get(request.id) === controller;
		try {
			if (request.params.operation === "ready") {
				if (!options?.ready) throw new Error("View readiness is unavailable");
				await options.ready(
					nonNegativeInteger(request.params.sequence ?? 0, "sequence"),
					AbortSignal.any([signal, controller.signal]),
				);
				if (!active()) return;
				const snapshot = options.checkpoint();
				if (active()) respond(request, { result: { ready: true, ...snapshot } });
				return;
			}
			const selector = readSelector(request.params.selector);
			const { format, ...readParameters } = readOptions(request.params.options);
			const value = await notebook.read(selector, {
				...readParameters,
				format: format === "json" ? "native" : format,
				signal: AbortSignal.any([signal, controller.signal]),
			});
			if (!active()) return;
			phase = "serialization";
			operation = "serialize read value";
			const { result, buffers } = readResponse(value, format);
			respond(request, { result }, buffers);
		} catch (cause) {
			if (active()) {
				const response: ResponseBody = {
					error: createDiagnostic(cause, {
						origin: "widget",
						phase,
						component: "packages/widget/src/requests.ts",
						operation,
					}),
				};
				if (request.params.operation === "ready" && options) response.diagnostics = options.checkpoint().diagnostics;
				if (active()) respond(request, response);
			}
		} finally {
			if (pending.get(request.id) === controller) pending.delete(request.id);
		}
	};
	const receive = (message: WireValue) => {
		if (!isRecord(message) || message.kind !== envelope.kind || message.protocol !== envelope.protocol) return;

		if (!isString(message.id) || !message.id || !isString(message.generation)) return;
		if (message.type === "cancel") {
			if (message.generation !== generation) return;
			const controller = pending.get(message.id);
			pending.delete(message.id);
			controller?.abort(new DOMException("Notebook request cancelled", "AbortError"));
			return;
		}
		// Custom messages reach every frontend sharing this widget model.
		if (message.type !== "request" || message.generation !== generation) return;
		const request: Request = {
			id: message.id,
			generation: message.generation,
			params: isRecord(message.params) ? message.params : {},
		};
		if (pending.has(request.id)) return;
		const controller = new AbortController();
		pending.set(request.id, controller);
		void execute(request, controller).catch((cause) => options?.onError(cause, "handle request"));
	};
	model.on("msg:custom", receive);
	signal.addEventListener(
		"abort",
		() => {
			try {
				model.off("msg:custom", receive);
				for (const controller of pending.values()) controller.abort(signal.reason);
				pending.clear();
				let changed = false;
				if (model.get("_inspection")?.generation === generation) {
					model.set("_inspection", {});
					changed = true;
				}
				if (model.get("_datasets")?.generation === generation) {
					model.set("_datasets", {});
					changed = true;
				}
				if (changed) model.save_changes();
			} catch (cause) {
				options?.onError(cause, "close request channel");
			}
		},
		{ once: true },
	);
	try {
		model.set("_inspection", { generation, value: notebook.inspection });
		model.set("_datasets", { generation, values: notebook.datasets });
		model.save_changes();
	} catch (cause) {
		if (!options) throw cause;
		options.onError(cause, "publish view metadata");
	}
	return publishDatasets;
}

function readSelector(value: WireValue | undefined): ReadSelector {
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

function readOptions(value: WireValue | undefined): WireReadOptions {
	if (value === undefined) return { format: "json" };
	if (!isRecord(value)) throw new TypeError("Read options must be an object");
	const options: WireReadOptions = { format: "json" };
	if (value.format !== undefined) {
		if (value.format !== "json" && value.format !== "rows" && value.format !== "arrow" && value.format !== "bytes") {
			throw new TypeError("Python reads require json, rows, arrow, or bytes format");
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

function readResponse(value: ReadResult, format: WireReadFormat): ReadResponse {
	const { data, format: _format, ...metadata } = value;
	if (format === "arrow" || format === "bytes") {
		if (!(data instanceof Uint8Array)) throw new TypeError("Binary reads must return a Uint8Array");
		const bytes = new Uint8Array(data);
		return { result: { ...metadata, format, binary: true }, buffers: [new DataView(bytes.buffer)] };
	}
	return { result: { ...metadata, format, data: encodeReadValue(data) }, buffers: [] };
}

function encodeReadValue<Value>(value: Value): WireValue {
	// Copy shared branches so the preview encoder does not summarize them as references.
	const copy = copyReadValue(value, { nodes: 500_000, bytes: 16 * 1024 * 1024, ancestors: new WeakSet() });
	const encoded = toWireValue(copy, { nodes: 500_000, bytes: 16 * 1024 * 1024 });
	assertExactValue(encoded);
	return encoded;
}

type ReadShapeBudget = { nodes: number; bytes: number; ancestors: WeakSet<object> };

function copyReadValue<Value>(value: Value, budget: ReadShapeBudget, depth = 0): RevivedValue {
	budget.nodes -= 1;
	budget.bytes -= isString(value) ? 32 + value.length * 6 : 32;
	if (budget.nodes < 0 || budget.bytes < 0 || depth >= 100) throw readShapeError();
	if (isCallable(value) || isSymbol(value)) throw readShapeError();
	if (value === null) return null;
	if (value === undefined) return undefined;
	if (isString(value) || isNumber(value) || isBigInt(value) || isBoolean(value)) return value;
	if (!isObjectValue(value)) throw readShapeError();
	const prototype = Object.getPrototypeOf(value);
	if (prototype === Date.prototype && value instanceof Date) {
		if (Reflect.ownKeys(value).length || !Number.isFinite(value.getTime())) throw readShapeError();
		return value;
	}
	if (budget.ancestors.has(value)) throw readShapeError();
	budget.ancestors.add(value);
	try {
		if (prototype === Map.prototype && value instanceof Map) {
			if (Reflect.ownKeys(value).length || value.size * 2 > budget.nodes) throw readShapeError();
			const copy = new Map<RevivedValue, RevivedValue>();
			for (const [key, item] of value) {
				copy.set(copyReadValue(key, budget, depth + 1), copyReadValue(item, budget, depth + 1));
			}
			return copy;
		}
		if (prototype === Set.prototype && value instanceof Set) {
			if (Reflect.ownKeys(value).length || value.size > budget.nodes) throw readShapeError();
			const copy = new Set<RevivedValue>();
			for (const item of value) copy.add(copyReadValue(item, budget, depth + 1));
			return copy;
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
			// The wire encoder visits holes as undefined values, including each shared branch.
			const holes = value.length - (keys.length - 1);
			budget.nodes -= holes;
			budget.bytes -= holes * 32;
			if (budget.nodes < 0 || budget.bytes < 0) throw readShapeError();
		}
		const copy: RevivedValue[] | RevivedRecord = array ? Array.from({ length: value.length }, () => undefined) : {};
		for (const key of keys) {
			if (array && key === "length") continue;
			if (!isString(key)) throw readShapeError();
			budget.bytes -= key.length * 6;
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor?.enumerable || !("value" in descriptor)) throw readShapeError();
			Object.defineProperty(copy, key, {
				value: copyReadValue(descriptor.value, budget, depth + 1),
				enumerable: true,
				configurable: true,
				writable: true,
			});
		}
		return copy;
	} finally {
		budget.ancestors.delete(value);
	}
}

function readShapeError(): TypeError {
	return new TypeError(
		"This value cannot be read exactly as JSON. Use Arrow, attachment bytes, or a smaller projection",
	);
}

function assertExactValue(value: WireValue): void {
	if (Array.isArray(value)) {
		for (const item of value) assertExactValue(item);
		return;
	}
	if (!isRecord(value)) return;
	const tag = value.__observablejs_type__;
	if (tag === "object" && isRecord(value.value)) {
		for (const item of Object.values(value.value)) if (item !== undefined) assertExactValue(item);
		return;
	}
	if (tag !== undefined && (!isString(tag) || !exactTags.has(tag))) {
		throw readShapeError();
	}
	for (const item of Object.values(value)) if (item !== undefined) assertExactValue(item);
}
