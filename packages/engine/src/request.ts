import { isRecord, type WireValue, type WireValues } from "@pyobservablejs/protocol";
import { isNumber, isString } from "@pyobservablejs/runtime/values";
import type { EvaluateOptions, NotebookSpec } from "@pyobservablejs/runtime/headless";
import type { AttachmentInfo, NotebookSource } from "@pyobservablejs/runtime";

export function source(value: WireValue | undefined): string | NotebookSpec {
	if (isString(value)) return value;
	if (!isRecord(value) || !Array.isArray(value.cells))
		throw new TypeError("Notebook source requires HTML or a cells specification");
	// SAFETY: Notebook Kit's toNotebook validates each cell and normalizes the specification.
	return value as NotebookSpec;
}

export function variables(value: WireValue | undefined): WireValues {
	if (!isRecord(value)) throw new TypeError("Variables must be an object");
	return Object.fromEntries(
		Object.entries(value).filter((entry): entry is [string, WireValue] => entry[1] !== undefined),
	);
}

export function options(value: WireValue | undefined): EvaluateOptions & { variables?: WireValues } {
	if (!isRecord(value)) throw new TypeError("Notebook options must be an object");
	const result: EvaluateOptions & { variables?: WireValues } = {};
	if (value.variables !== undefined) result.variables = variables(value.variables);
	if (value.baseUrl !== undefined) {
		if (!isString(value.baseUrl)) throw new TypeError("baseUrl must be a string");
		result.baseUrl = value.baseUrl;
	}
	if (value.keys !== undefined) {
		if (!Array.isArray(value.keys) || !value.keys.every(isString))
			throw new TypeError("keys must be an array of strings");
		result.keys = value.keys;
	}
	if (value.selection !== undefined) {
		if (
			!Array.isArray(value.selection) ||
			!value.selection.every((index) => isNumber(index) && Number.isSafeInteger(index) && index >= 0)
		)
			throw new TypeError("selection must be an array of cell indexes");
		result.selection = value.selection.filter(isNumber);
	}
	if (value.attachments !== undefined) {
		if (!isRecord(value.attachments)) throw new TypeError("attachments must be an object");
		const attachments: Record<string, AttachmentInfo> = {};
		for (const [name, file] of Object.entries(value.attachments)) {
			if (!isRecord(file) || !isString(file.url)) throw new TypeError("Attachment requires a URL");
			const attachment: AttachmentInfo = { url: file.url };
			if (isString(file.mimeType)) attachment.mimeType = file.mimeType;
			if (isNumber(file.size)) attachment.size = file.size;
			if (isNumber(file.lastModified)) attachment.lastModified = file.lastModified;
			Object.defineProperty(attachments, name, { value: attachment, enumerable: true });
		}
		result.attachments = attachments;
	}
	return result;
}

export function resolvedSource(value: WireValue | undefined): NotebookSource {
	if (!isRecord(value)) throw new TypeError("Notebook import must return source metadata");
	const settings = options(value);
	const notebook = source(value.source);
	return { source: notebook, attachments: settings.attachments, baseUrl: settings.baseUrl };
}
