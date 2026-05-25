import type { RenderProps } from "@anywidget/types";
import type { CellExports, WidgetModel } from "./types";
import widget from "./widget";

export type Model = RenderProps<WidgetModel>["model"];
export type TestModel = Model & {
	listenerCount(name: string): number;
};
export type ChildRender = (options: { el: HTMLElement; signal?: AbortSignal }) => Promise<void> | void;

const noopCellExports: CellExports = {
	bindRuntime() {},
	unbindRuntime() {},
	prepareComposedRender() {},
};

export function createModel(
	initial: Partial<WidgetModel>,
	widgetManager?: { get_model(modelId: string): Promise<Model | undefined> | Model | undefined },
): TestModel {
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
		listenerCount(name: string) {
			return listeners.get(name)?.size ?? 0;
		},
		widget_manager: widgetManager,
	} as unknown as TestModel;
}

export function createHost(
	childModels: Map<string, Model>,
	childExports: Map<string, CellExports> = new Map(),
	childRenders: Map<string, ChildRender> = new Map(),
): RenderProps<WidgetModel>["host"] {
	return {
		getModel: async (ref: string) => childModels.get(ref),
		getWidget: async (ref: string) => ({
			exports: childExports.get(ref) ?? noopCellExports,
			render: async (options: { el: HTMLElement; signal?: AbortSignal }) => {
				await childRenders.get(ref)?.(options);
			},
		}),
	} as unknown as RenderProps<WidgetModel>["host"];
}

export function renderChildrenThroughWidget(childModels: Map<string, Model>): Map<string, ChildRender> {
	const childRenders = new Map<string, ChildRender>();
	for (const [ref, childModel] of childModels) {
		childRenders.set(ref, ({ el, signal }) => {
			widget.render({
				model: childModel,
				el,
				signal: signal ?? new AbortController().signal,
				host: createHost(new Map()),
			} as unknown as RenderProps<WidgetModel>);
		});
	}
	return childRenders;
}

export function countingChildRenders(
	childModels: Map<string, Model>,
	counts: Map<string, number>,
): Map<string, ChildRender> {
	const childRenders = new Map<string, ChildRender>();
	for (const [ref, childModel] of childModels) {
		childRenders.set(ref, ({ el, signal }) => {
			counts.set(ref, (counts.get(ref) ?? 0) + 1);
			widget.render({
				model: childModel,
				el,
				signal: signal ?? new AbortController().signal,
				host: createHost(new Map()),
			} as unknown as RenderProps<WidgetModel>);
		});
	}
	return childRenders;
}

export function createCellExportsMap(childModels: Map<string, Model>): Map<string, CellExports> {
	return new Map(Array.from(childModels, ([ref, childModel]) => [ref, createCellExports(childModel)]));
}

export function createCellExports(model: Model): CellExports {
	return widget.initialize({
		model,
		signal: new AbortController().signal,
		experimental: {},
	} as unknown as Parameters<typeof widget.initialize>[0]) as CellExports;
}

export function trackingCellExports(name: string, events: string[]): CellExports {
	return {
		bindRuntime() {
			events.push(`bind:${name}`);
		},
		unbindRuntime() {
			events.push(`unbind:${name}`);
		},
		prepareComposedRender() {
			events.push(`prepare:${name}`);
		},
	};
}

export function variableValue(model: Model, name: string): unknown | undefined {
	const variables = model.get("_values");
	if (variables === null || typeof variables !== "object" || Array.isArray(variables)) return undefined;
	return (variables as Record<string, unknown>)[name];
}

export async function waitFor<T>(read: () => T | undefined): Promise<T> {
	const deadline = performance.now() + 1000;
	return new Promise<T>((resolve, reject) => {
		const check = () => {
			const value = read();
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
