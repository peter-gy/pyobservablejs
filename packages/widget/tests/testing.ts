import type { Experimental, Host, InitializeProps, RenderProps } from "@anywidget/types";
import type { NotebookGraph, WireValue, WireValues } from "@pyobservablejs/runtime";
import createWidget from "../src";
import type { WidgetModel } from "../src/model";

export type Model = RenderProps<WidgetModel>["model"];
export type TestModel = Model & {
	saveCount(): number;
	savedReadbacks(): NonNullable<WidgetModel["_readback"]>[];
};
type WidgetDefinition = ReturnType<typeof createWidget>;
type Readback = NonNullable<WidgetModel["_readback"]>;
type ReadbackResult = Readback["results"][string];
type Listener = (...arguments_: never[]) => void;

const experimental: Experimental = {
	async invoke<T>(): Promise<[T, DataView[]]> {
		throw new Error("Unexpected experimental invocation");
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
	return new TestWidgetModel(initial);
}

class TestWidgetModel implements TestModel {
	readonly widget_manager: Model["widget_manager"] = {
		async get_model() {
			throw new Error("Unexpected widget-manager model lookup");
		},
	};

	readonly #state: WidgetModel;
	readonly #listeners = new Map<string, Set<Listener>>();
	readonly #savedReadbacks: Readback[] = [];
	#saves = 0;

	constructor(initial: Partial<WidgetModel>) {
		this.#state = { ...initial };
	}

	get<Key extends keyof WidgetModel>(name: Key): WidgetModel[Key] {
		return this.#state[name];
	}

	set<Key extends keyof WidgetModel>(name: Key, value: WidgetModel[Key]): void {
		this.#state[name] = value;
		for (const listener of this.#listeners.get(`change:${name}`) ?? []) listener();
	}

	saveCount(): number {
		return this.#saves;
	}

	savedReadbacks(): Readback[] {
		return this.#savedReadbacks;
	}

	save_changes(): void {
		this.#saves += 1;
		const readback = this.#state._readback;
		if (readback) this.#savedReadbacks.push(structuredClone(readback));
	}

	on(eventName: "msg:custom", callback: (message: WireValue, buffers: DataView[]) => void): void;
	on(eventName: `change:${string}`, callback: () => void): void;
	on(eventName: string, callback: Listener): void;
	on(eventName: string, callback: Listener): void {
		const callbacks = this.#listeners.get(eventName) ?? new Set();
		callbacks.add(callback);
		this.#listeners.set(eventName, callbacks);
	}

	off(eventName?: string | null, callback?: Listener | null): void {
		if (eventName == null) {
			this.#listeners.clear();
			return;
		}
		if (callback == null) {
			this.#listeners.delete(eventName);
			return;
		}
		this.#listeners.get(eventName)?.delete(callback);
	}

	send(): void {
		throw new Error("Unexpected custom model message");
	}
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
			// SAFETY: The test registry contains WidgetModel instances, and the widget requests that exact model shape.
			return (await resolve(ref)) as never;
		},
		getWidget: async (ref: string) => {
			throw new Error(`Unexpected reverse widget lookup ${ref}`);
		},
	};
	return host;
}

export function createSession(initial: Partial<WidgetModel>): TestModel {
	return createModel({
		_model_role: "session",
		_attachments: {},
		_variables: {},
		_view_values: {},
		_options: {},
		...initial,
	});
}

export function createView(ref = "anywidget:session", cellIndexes: number[] | null = null): TestModel {
	return createModel({
		_session: ref,
		_cell_indexes: cellIndexes,
		_readback: {
			revision: 0,
			input_revision: null,
			settled_revision: null,
			pending: false,
			graph: {},
			results: {},
			errors: [],
		},
	});
}

export interface NotebookFixture {
	session: TestModel;
	view: TestModel;
	host: TestHost;
}

export function createNotebookFixture(initial: Partial<WidgetModel>): NotebookFixture {
	const session = createSession(initial);
	const view = createView();
	const host = createHost(new Map([["anywidget:session", session]]));
	return { session, view, host };
}

export function setVariables(model: TestModel, seq: number, kind: "set" | "replace", values: WireValues): void {
	const previous = model.get("_variables");
	model.set("_variable_update", { seq, kind, values });
	model.set("_variables", kind === "set" ? { ...previous, ...values } : values);
}

export function setRange(input: HTMLInputElement, value: number): void {
	input.value = String(value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
	input.dispatchEvent(new Event("change", { bubbles: true }));
}

export function renderProps<State extends WidgetModel>(
	model: RenderProps<State>["model"],
	el: HTMLElement,
	signal: AbortSignal,
	host: Host = createHost(new Map()),
): RenderProps<State> {
	return { model, el, signal, host, experimental };
}

export function initializeProps<State extends WidgetModel>(
	model: InitializeProps<State>["model"],
	signal: AbortSignal,
): InitializeProps<State> {
	return { model, signal, experimental };
}

export function variableValue(model: Model, name: string): WireValue | undefined {
	const owners = cellRecords(model).filter(
		(record) => record.rendered && Object.prototype.hasOwnProperty.call(record.values, name),
	);
	return owners.length === 1 ? owners[0]?.values[name] : undefined;
}

export type CellRecord = {
	rendered: boolean;
	names: string[];
	values: WireValues;
	revision: number;
	status: "pending" | "success" | "error";
	errors: ReadbackResult["errors"];
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
	return Array.isArray(graph.cells) && Array.isArray(graph.edges)
		? { cells: graph.cells, edges: graph.edges }
		: undefined;
}

export function hasRendered(model: Model): boolean {
	const readback = readbackValue(model);
	return readback.input_revision !== null && readback.settled_revision === readback.input_revision && !readback.pending;
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
	return matches[0];
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

function readCellValues(model: Model): Readback["results"] {
	return readbackValue(model).results;
}

function readbackValue(model: Model): Readback {
	return (
		model.get("_readback") ?? {
			revision: 0,
			input_revision: null,
			settled_revision: null,
			pending: false,
			graph: {},
			results: {},
			errors: [],
		}
	);
}

function readCellRecord(record: ReadbackResult | undefined): CellRecord | undefined {
	if (!record) return undefined;
	return {
		rendered: record.status !== "pending",
		names: Object.keys(record.values),
		values: record.values,
		revision: record.revision,
		status: record.status,
		errors: record.errors,
	};
}
