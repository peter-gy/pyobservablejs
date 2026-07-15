import type { Experimental, Host, InitializeProps, RenderProps } from "@anywidget/types";
import type { NotebookGraph } from "@pyobservablejs/runtime";
import createWidget from "../src";
import type { WidgetModel } from "../src/model";

export type Model = RenderProps<WidgetModel>["model"];
export type TestModel = Model & {
	saveCount(): number;
	savedReadbacks(): NonNullable<WidgetModel["_readback"]>[];
};
type WidgetDefinition = ReturnType<typeof createWidget>;

const experimental: Experimental = {
	async invoke<T>(): Promise<[T, DataView[]]> {
		return [undefined as T, []];
	},
};

const definitions = new WeakMap<Model, WidgetDefinition>();

function definitionFor(model: Model): WidgetDefinition {
	let definition = definitions.get(model);
	if (definition) return definition;
	definition = createWidget();
	definitions.set(model, definition);
	definition.initialize(initializeProps(model, new AbortController().signal));
	return definition;
}

export const widget = {
	render(props: RenderProps<WidgetModel>) {
		definitionFor(props.model).render(props);
	},
};

export function createModel(initial: Partial<WidgetModel>): TestModel {
	const state = new Map<string, unknown>(Object.entries(initial));
	const listeners = new Map<string, Set<() => void>>();
	let saves = 0;
	const savedReadbacks: NonNullable<WidgetModel["_readback"]>[] = [];
	return {
		get(name: string) {
			return state.get(name);
		},
		set(name: string, value: unknown) {
			state.set(name, value);
			for (const listener of listeners.get(`change:${name}`) ?? []) listener();
		},
		saveCount() {
			return saves;
		},
		savedReadbacks() {
			return savedReadbacks;
		},
		save_changes() {
			saves += 1;
			const readback = state.get("_readback");
			if (readback !== null && typeof readback === "object" && !Array.isArray(readback)) {
				savedReadbacks.push(structuredClone(readback) as NonNullable<WidgetModel["_readback"]>);
			}
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

export type TestHost = Host & {
	modelLookups: string[];
};

export function createHost(models: ReadonlyMap<string, Model | Promise<Model>>): TestHost {
	const modelLookups: string[] = [];
	const resolve = async (ref: string): Promise<Model> => {
		const model = models.get(ref);
		if (!model) throw new Error(`Unknown widget model ${ref}`);
		return await model;
	};
	const host: TestHost = {
		modelLookups,
		getModel: async (ref: string) => {
			modelLookups.push(ref);
			return (await resolve(ref)) as never;
		},
		getWidget: async (ref: string) => {
			throw new Error(`Unexpected reverse widget lookup ${ref}`);
		},
	};
	return host;
}

export function createSession(initial: Omit<Partial<WidgetModel>, "role">): TestModel {
	return createModel({
		role: "session",
		_attachments: {},
		_variables: {},
		_view_values: {},
		_options: {},
		...initial,
	});
}

export function createView(ref = "anywidget:session", cellIndexes: number[] | null = null): TestModel {
	return createModel({
		role: "view",
		_notebook: ref,
		_cell_indexes: cellIndexes,
		_readback: { revision: 0, rendered: false, graph: {}, cells: {} },
	});
}

export function createNotebookFixture(initial: Omit<Partial<WidgetModel>, "role">): {
	session: TestModel;
	view: TestModel;
	host: TestHost;
} {
	const session = createSession(initial);
	const view = createView();
	const host = createHost(new Map([["anywidget:session", session]]));
	return { session, view, host };
}

export function setVariables(
	model: TestModel,
	seq: number,
	kind: "set" | "replace",
	values: Record<string, unknown>,
): void {
	const previous = model.get("_variables");
	model.set("_variable_update", { seq, kind, values });
	model.set(
		"_variables",
		kind === "set" && previous && typeof previous === "object" ? { ...previous, ...values } : values,
	);
}

export function setRange(input: HTMLInputElement, value: number): void {
	input.value = String(value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
	input.dispatchEvent(new Event("change", { bubbles: true }));
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

export function variableValue(model: Model, name: string): unknown {
	const owners = cellRecords(model).filter(
		(record) => record.rendered && Object.prototype.hasOwnProperty.call(record.values, name),
	);
	return owners.length === 1 ? owners[0]?.values[name] : undefined;
}

export type CellRecord = {
	rendered: boolean;
	names: string[];
	values: Record<string, unknown>;
};

export function cellRecord(model: Model, index: number): CellRecord | undefined {
	return readCellRecord(readCellValues(model)[String(index)]);
}

export function cellRecords(model: Model): CellRecord[] {
	return Object.values(readCellValues(model)).flatMap((value) => {
		const record = readCellRecord(value);
		return record ? [record] : [];
	});
}

export function graphValue(model: Model): NotebookGraph | undefined {
	const graph = readbackValue(model).graph;
	if (graph === null || typeof graph !== "object" || Array.isArray(graph)) return undefined;
	const value = graph as Partial<NotebookGraph>;
	return Array.isArray(value.cells) && Array.isArray(value.edges) ? (graph as NotebookGraph) : undefined;
}

export function hasRendered(model: Model): boolean {
	return readbackValue(model).rendered === true;
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

function readCellValues(model: Model): Record<string, unknown> {
	const value = readbackValue(model).cells;
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readbackValue(model: Model): Partial<NonNullable<WidgetModel["_readback"]>> {
	const value = model.get("_readback");
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function readCellRecord(value: unknown): CellRecord | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Partial<CellRecord>;
	if (!Array.isArray(record.names) || record.values === null || typeof record.values !== "object") return undefined;
	return {
		rendered: record.rendered === true,
		names: record.names.filter((name): name is string => typeof name === "string"),
		values: record.values as Record<string, unknown>,
	};
}
