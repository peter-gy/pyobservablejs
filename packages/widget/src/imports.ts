import { isString } from "@pyobservablejs/runtime/values";
import type { NotebookSource, ResolveNotebook } from "@pyobservablejs/runtime";
import type { AttachmentInfo } from "@pyobservablejs/runtime";
import { isRecord, type AnyWidgetModel } from "./model";
import type { WireRecord, WireValue } from "./values";

export function connectNotebookSources(model: AnyWidgetModel, lifetime: AbortSignal): ResolveNotebook {
	lifetime.throwIfAborted();
	const pending = new Map<string, { resolve(value: NotebookSource): void; reject(error: Error): void }>();
	const receive = (message: WireValue) => {
		if (!isRecord(message) || message.kind !== "observablejs:import" || message.type !== "response") return;
		if (!isString(message.id)) return;
		const request = pending.get(message.id);
		if (!request) return;
		pending.delete(message.id);
		if (message.protocol !== 1) request.reject(new Error("Invalid notebook import protocol"));
		else if (isRecord(message.error) && isString(message.error.message))
			request.reject(new Error(message.error.message));
		else if (isRecord(message.result) && isString(message.result.source)) {
			try {
				request.resolve(parseNotebookSource(message.result));
			} catch (cause) {
				request.reject(cause instanceof Error ? cause : new Error("Invalid notebook source response"));
			}
		} else request.reject(new Error("Invalid notebook import response"));
	};
	model.on("msg:custom", receive);
	lifetime.addEventListener(
		"abort",
		() => {
			model.off("msg:custom", receive);
		},
		{ once: true },
	);
	return async (specifier, options) => {
		const signal = AbortSignal.any([lifetime, options.signal]);
		signal.throwIfAborted();
		const id = crypto.randomUUID();
		let abort: () => void = () => {};
		try {
			return await new Promise<NotebookSource>((resolve, reject) => {
				pending.set(id, { resolve, reject });
				abort = () => {
					if (!pending.delete(id)) return;
					try {
						model.send({ kind: "observablejs:import", protocol: 1, type: "cancel", id });
					} finally {
						reject(new Error(lifetime.aborted ? "Notebook view closed" : "Notebook import cancelled"));
					}
				};
				signal.addEventListener("abort", abort, { once: true });
				model.send({ kind: "observablejs:import", protocol: 1, type: "request", id, specifier });
			});
		} finally {
			pending.delete(id);
			signal.removeEventListener("abort", abort);
		}
	};
}

function parseNotebookSource(value: WireRecord): NotebookSource {
	if (!isString(value.source)) throw new Error("Notebook source must be a string");
	if (value.baseUrl !== undefined && !isString(value.baseUrl))
		throw new Error("Notebook source base URL must be a string");
	if (value.attachments !== undefined && !isRecord(value.attachments))
		throw new Error("Notebook source attachments must be an object");
	// SAFETY: Python serializes validated attachment records on this private source channel.
	const attachments = value.attachments as Record<string, AttachmentInfo> | undefined;
	return { source: value.source, attachments, baseUrl: value.baseUrl };
}
