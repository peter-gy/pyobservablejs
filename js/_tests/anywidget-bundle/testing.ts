import type { AnyModel } from "@anywidget/types";

export type TestState = Record<string, unknown>;
export type ModuleValue = string | { error: { code: string; message: string } } | (() => ModuleValue);

type MessageHandler = (message: unknown, buffers: DataView[]) => void;

export function respondingModel(
	modules: ReadonlyMap<string, ModuleValue>,
	options: {
		delays?: Readonly<Record<string, number>>;
		respond?: boolean;
		buffers?: DataView[];
		responsePath?: string;
	} = {},
) {
	const listeners = new Set<MessageHandler>();
	const requested: string[] = [];
	let inFlight = 0;
	let maxInFlight = 0;
	const model = {
		on(name: string, callback: MessageHandler) {
			if (name === "msg:custom") listeners.add(callback);
		},
		off(name?: string | null, callback?: MessageHandler | null) {
			if (name !== "msg:custom") return;
			if (callback) listeners.delete(callback);
			else listeners.clear();
		},
		send(content: unknown) {
			if (!isRequest(content)) return;
			requested.push(content.path);
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			if (options.respond === false) return;
			globalThis.setTimeout(() => {
				inFlight -= 1;
				const configured = modules.get(content.path);
				const value = typeof configured === "function" ? configured() : configured;
				if (typeof value === "object" && value !== null && "error" in value) {
					emit(
						{
							type: "anywidget-bundle:response",
							version: 1,
							id: content.id,
							path: content.path,
							error: value.error,
						},
						[],
					);
					return;
				}
				const source = typeof value === "string" ? value : "";
				emit(
					{
						type: "anywidget-bundle:response",
						version: 1,
						id: content.id,
						path: options.responsePath ?? content.path,
					},
					options.buffers ?? [sourceBuffer(source)],
				);
			}, options.delays?.[content.path] ?? 0);
		},
	} as unknown as AnyModel<TestState>;

	function emit(message: unknown, buffers: DataView[]) {
		for (const listener of listeners) listener(message, buffers);
	}

	return {
		model,
		requested,
		get maxInFlight() {
			return maxInFlight;
		},
		get listenerCount() {
			return listeners.size;
		},
	};
}

export function sourceBuffer(source: string): DataView {
	const bytes = new TextEncoder().encode(source);
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function isRequest(value: unknown): value is { id: string; path: string } {
	if (value === null || typeof value !== "object") return false;
	const request = value as Record<string, unknown>;
	return (
		request.type === "anywidget-bundle:request" &&
		request.version === 1 &&
		typeof request.id === "string" &&
		typeof request.path === "string"
	);
}
