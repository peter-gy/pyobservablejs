import type { RenderProps } from "@anywidget/types";
import type { CellExports, WidgetModel } from "./types";
import widget from "./widget";

export type Model = RenderProps<WidgetModel>["model"];
export type TestModel = Model;
export type ChildRender = (options: { el: HTMLElement; signal?: AbortSignal }) => Promise<void> | void;

export const objectValuedSelectSource = `
Select = (items, options = {}) => {
  const form = document.createElement("form");
  const select = document.createElement("select");
  let selected = options.value ?? items[0];
  for (const [index, item] of items.entries()) {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = String(item.pointDensity);
    select.appendChild(option);
  }
  select.value = String(items.indexOf(selected));
  const update = () => {
    selected = items[select.selectedIndex] ?? null;
  };
  select.addEventListener("input", update);
  select.addEventListener("change", update);
  Object.defineProperty(form, "value", {
    get() { return selected; },
    set(value) {
      selected = items.includes(value) ? value : null;
      select.selectedIndex = items.indexOf(value);
    },
  });
  form.appendChild(select);
  return form;
}`;

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

export function variableValue(model: Model, name: string): unknown | undefined {
	const variables = model.get("_values");
	if (variables === null || typeof variables !== "object" || Array.isArray(variables)) return undefined;
	return (variables as Record<string, unknown>)[name];
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
