import type { Experimental, Host, InitializeProps, RenderProps } from "@anywidget/types";
import type { NotebookGraph } from "@/runtime/graph";
import type { WidgetModel } from "@/widget/model";

export type Model = RenderProps<WidgetModel>["model"];
export type TestModel = Model & {
	savedTraits: Set<string>;
	listenerCount(name: string): number;
};
const experimental: Experimental = {
	async invoke<T>(): Promise<[T, DataView[]]> {
		return [undefined as T, []];
	},
};

export function createModel(initial: Partial<WidgetModel>): TestModel {
	const state = new Map<string, unknown>(Object.entries(initial));
	const dirtyTraits = new Set<string>();
	const savedTraits = new Set<string>();
	const listeners = new Map<string, Set<() => void>>();
	return {
		savedTraits,
		listenerCount(name: string) {
			return listeners.get(name)?.size ?? 0;
		},
		get(name: string) {
			return state.get(name);
		},
		set(name: string, value: unknown) {
			state.set(name, value);
			dirtyTraits.add(name);
			for (const listener of listeners.get(`change:${name}`) ?? []) listener();
		},
		save_changes() {
			for (const name of dirtyTraits) savedTraits.add(name);
			dirtyTraits.clear();
		},
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
	} as unknown as TestModel;
}

export function createHost(childModels: ReadonlyMap<string, Model | Promise<Model>>): RenderProps<WidgetModel>["host"] {
	const host: Host = {
		getModel: async (ref: string) => {
			const model = childModels.get(ref);
			if (!model) throw new Error(`Unknown widget model ${ref}`);
			return (await model) as never;
		},
		getWidget: async () => {
			throw new Error("Test host does not render child widgets");
		},
	};
	return host;
}

export function renderProps<State extends Record<string, unknown>>(
	model: RenderProps<State>["model"],
	el: HTMLElement,
	signal: AbortSignal,
	host: Host = createHost(new Map()),
): RenderProps<State> {
	return { model, el, signal, host, experimental };
}

export function initializeProps<State extends Record<string, unknown>>(
	model: InitializeProps<State>["model"],
	signal: AbortSignal,
): InitializeProps<State> {
	return { model, signal, experimental };
}

export function variableValue(model: Model, name: string): unknown | undefined {
	const variables = model.get("_values");
	if (variables === null || typeof variables !== "object" || Array.isArray(variables)) return undefined;
	return (variables as Record<string, unknown>)[name];
}

export function graphValue(model: Model): NotebookGraph | undefined {
	const graph = model.get("_graph");
	if (graph === null || typeof graph !== "object" || Array.isArray(graph)) return undefined;
	const value = graph as Partial<NotebookGraph>;
	return Array.isArray(value.cells) && Array.isArray(value.edges) ? (graph as NotebookGraph) : undefined;
}

export async function waitFor<T>(read: () => T | undefined, timeoutMs = 1000): Promise<T> {
	const deadline = performance.now() + timeoutMs;
	return new Promise<T>((resolve, reject) => {
		const check = () => {
			let value: T | undefined;
			try {
				value = read();
			} catch (error) {
				reject(error);
				return;
			}
			if (value !== undefined) {
				resolve(value);
			} else if (performance.now() >= deadline) {
				reject(new Error("Timed out waiting for value"));
			} else {
				window.setTimeout(check, 10);
			}
		};
		check();
	});
}

export function composedText(el: HTMLElement, value: string): HTMLElement | undefined {
	const matches = Array.from(el.querySelectorAll<HTMLElement>("*")).filter((item) => {
		if (isHidden(item) || item.getAttribute("role") === "alert" || item.textContent?.trim() !== value) return false;
		return !Array.from(item.children).some((child) => child.textContent?.trim() === value);
	});
	if (matches.length === 0) return undefined;
	if (matches.length > 1) throw new Error(`Expected one visible output with ${value}, found ${matches.length}`);
	return matches[0]!;
}

export function alertText(el: HTMLElement): string | undefined {
	const alerts = Array.from(el.querySelectorAll<HTMLElement>("[role='alert']")).filter((alert) => !isHidden(alert));
	if (alerts.length === 0) return undefined;
	if (alerts.length > 1) throw new Error(`Expected one alert, found ${alerts.length}`);
	return alerts[0]?.textContent?.trim() || undefined;
}

function isHidden(item: HTMLElement): boolean {
	return item.closest("[hidden], [aria-hidden='true']") !== null;
}
