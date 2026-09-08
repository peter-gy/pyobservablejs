import { createFileAttachment, type AttachmentRegistry } from "./attachments";
import { describeDataset, readDataset, type DatasetDescription } from "./datasets";
import type { NotebookInspection } from "./inspection";
import type { NotebookValues, ValueSelector } from "./notebook-values";
import { isNumber, isObjectValue, isString } from "./value-kind";
import type { RuntimeValue } from "./values";

export type ReadSelector = ValueSelector | { attachment: string };
export type ReadOptions = {
	format?: "native" | "rows" | "arrow" | "bytes";
	columns?: readonly string[];
	offset?: number;
	limit?: number;
	revision?: number;
	signal?: AbortSignal;
};
export type NotebookRead = Readonly<{
	cell: number | null;
	name: string | null;
	revision: number;
	format: NonNullable<ReadOptions["format"]>;
	data: RuntimeValue;
	dataset?: DatasetDescription;
	mimeType?: string;
}>;
export type ReadContext = {
	values: NotebookValues;
	inspection: NotebookInspection;
	attachments: AttachmentRegistry;
	baseUrl: string;
	signal: AbortSignal;
};

export async function readNotebook(
	selector: ReadSelector,
	options: ReadOptions,
	context: ReadContext,
): Promise<NotebookRead> {
	const signal = options.signal ? AbortSignal.any([options.signal, context.signal]) : context.signal;
	signal.throwIfAborted();
	if (
		(options.format === "bytes" || (!isString(selector) && "attachment" in selector)) &&
		(options.columns !== undefined || (options.offset ?? 0) !== 0 || options.limit !== undefined)
	)
		throw new Error("Byte reads do not accept dataset projection or row ranges");
	if (!isString(selector) && "attachment" in selector) {
		if (options.format !== undefined && options.format !== "bytes")
			throw new Error("Attachment reads use format bytes");
		if (!context.inspection.attachments.some((file) => file.name === selector.attachment))
			throw new Error("Unknown notebook attachment");
		const file = createFileAttachment(context.baseUrl, context.attachments)(selector.attachment);
		const response = await fetch(file.href, { signal });
		if (!response.ok) throw new Error(`Unable to read attachment ${selector.attachment}: HTTP ${response.status}`);
		const data = new Uint8Array(await response.arrayBuffer());
		signal.throwIfAborted();
		return Object.freeze({
			cell: null,
			name: selector.attachment,
			revision: 0,
			format: "bytes",
			data,
			mimeType: file.mimeType || "application/octet-stream",
		});
	}
	const revision =
		options.revision ??
		(!isString(selector) && "revision" in selector && isNumber(selector.revision) ? selector.revision : undefined);
	if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0))
		throw new Error("Read revision must be a nonnegative safe integer");
	const entry = await context.values.wait(selector, signal, revision);
	const path = isString(selector) ? [] : (selector.path ?? []);
	const value = readPath(entry.value, path);
	const format = options.format ?? "native";
	let data = value;
	let dataset: DatasetDescription | undefined;
	if (
		format === "arrow" ||
		format === "rows" ||
		options.columns !== undefined ||
		(options.offset ?? 0) !== 0 ||
		options.limit !== undefined
	) {
		const result = await readDataset(value, {
			...options,
			format: format === "bytes" ? "native" : format,
		});
		data = result.data;
		dataset = result.description;
	} else {
		dataset = describeDataset(value) ?? undefined;
		if (format === "bytes") {
			if (value instanceof ArrayBuffer) data = new Uint8Array(value);
			else if (ArrayBuffer.isView(value)) data = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
			else throw new Error("Byte reads require an ArrayBuffer or typed array");
		}
	}
	signal.throwIfAborted();
	if (context.values.entry(selector).revision !== entry.revision) throw new Error("Dataset changed during the read");
	return Object.freeze({
		cell: entry.cell,
		name: entry.name,
		revision: entry.revision,
		format,
		data,
		dataset,
		mimeType: format === "arrow" ? "application/vnd.apache.arrow.stream" : undefined,
	});
}

function readPath(value: RuntimeValue, path: readonly (string | number)[]): RuntimeValue {
	for (const key of path) {
		if (!isString(key) && (!isNumber(key) || !Number.isSafeInteger(key) || key < 0))
			throw new Error("Value paths contain property names or nonnegative indexes");
		if (!isObjectValue(value)) throw new Error(`Value path ${String(key)} does not address an object`);
		const property = Object.getOwnPropertyDescriptor(value, key);
		if (!property || !("value" in property)) throw new Error(`Value path ${String(key)} needs an own data property`);
		value = property.value;
	}
	return value;
}
