import type { RenderProps } from "@anywidget/types";
import type { WidgetModel } from "./widget/types";

export type Model = RenderProps<WidgetModel>["model"];
export type TestModel = Model & {
	savedTraits: Set<string>;
};
export type TestWidgetManager = {
	get_model(modelId: string): Promise<Model | undefined> | Model | undefined;
};

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

export function createModel(initial: Partial<WidgetModel>, widgetManager?: TestWidgetManager): TestModel {
	const state = new Map<string, unknown>(Object.entries(initial));
	const dirtyTraits = new Set<string>();
	const savedTraits = new Set<string>();
	const listeners = new Map<string, Set<() => void>>();
	return {
		savedTraits,
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
		...(widgetManager ? { widget_manager: widgetManager } : {}),
	} as unknown as TestModel;
}

export function hasSavedTrait(model: Model, name: string): boolean {
	return (model as TestModel).savedTraits.has(name);
}

export function createHost(childModels: Map<string, Model>): RenderProps<WidgetModel>["host"] {
	return {
		getModel: async (ref: string) => childModels.get(ref),
		getWidget: async () => {
			throw new Error("Test host resolves child models only");
		},
	} as unknown as RenderProps<WidgetModel>["host"];
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
