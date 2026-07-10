import type { AnyModel, Experimental, Host, InitializeProps, RenderProps } from "@anywidget/types";

export type TestState = Record<string, unknown>;
export type ModuleValue = string | { error: { code: string; message: string } } | (() => ModuleValue);

type MessageHandler = (message: unknown, buffers: DataView[]) => void;

const experimental: Experimental = {
	async invoke<T>(): Promise<[T, DataView[]]> {
		return [undefined as T, []];
	},
};

const host: Host = {
	async getModel(ref) {
		throw new Error(`Unknown widget model ${ref}`);
	},
	async getWidget() {
		throw new Error("Test host does not render child widgets");
	},
};

export function createModel(initial: Partial<TestState>): AnyModel<TestState> {
	const state = new Map<string, unknown>(Object.entries(initial));
	const listeners = new Map<string, Set<() => void>>();
	return {
		get(name: string) {
			return state.get(name);
		},
		set(name: string, value: unknown) {
			state.set(name, value);
			for (const listener of listeners.get(`change:${name}`) ?? []) listener();
		},
		save_changes() {},
		on(name: string, callback: () => void) {
			const callbacks = listeners.get(name) ?? new Set();
			callbacks.add(callback);
			listeners.set(name, callbacks);
		},
		off(name?: string | null, callback?: (() => void) | null) {
			if (name == null) {
				listeners.clear();
				return;
			}
			if (callback == null) {
				listeners.delete(name);
				return;
			}
			listeners.get(name)?.delete(callback);
		},
	} as unknown as AnyModel<TestState>;
}

export function initializeProps(
	model: InitializeProps<TestState>["model"],
	signal: AbortSignal,
): InitializeProps<TestState> {
	return { model, signal, experimental };
}

export function renderProps(
	model: RenderProps<TestState>["model"],
	el: HTMLElement,
	signal: AbortSignal,
): RenderProps<TestState> {
	return { model, el, signal, host, experimental };
}

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
