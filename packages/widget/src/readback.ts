import type { Notebook } from "@observablehq/notebook-kit";
import {
	createNotebookGraph,
	createNotebookGraphFromAnalysis,
	sameWireValue,
	type NotebookAnalysis,
	type NotebookGraph,
} from "@pyobservablejs/runtime";
import { NOTEBOOK_MODEL_CHANGE_EVENTS, type AnyWidgetModel, type WidgetModel } from "./model";

export type CellReadback = {
	rendered: boolean;
	names: string[];
	values: Record<string, unknown>;
};

type ViewKind = "full" | "projection";

type ViewState = {
	kind: ViewKind;
	version: number;
	settled: Set<number>;
	closed: boolean;
};

export type ReadbackView = object;

export type ReadbackAttempt = {
	view: ReadbackView;
	generation: number;
	version: number;
};

const EMPTY_CELL_READBACK: CellReadback = {
	rendered: false,
	names: [],
	values: {},
};

/**
 * Keep one successful snapshot per Notebook model while rejecting writes from
 * superseded render attempts. View starts and teardown never erase another
 * live view's readback; notebook input changes invalidate the model generation.
 */
export class NotebookReadback {
	readonly #model: AnyWidgetModel;
	readonly #views = new Map<ReadbackView, ViewState>();
	#cells: NonNullable<WidgetModel["_cell_values"]>;
	#generation = 0;

	constructor(model: AnyWidgetModel, signal: AbortSignal) {
		this.#model = model;
		this.#cells = readCellReadbacks(model);
		const invalidate = () => this.#invalidate();
		for (const event of NOTEBOOK_MODEL_CHANGE_EVENTS) model.on(event, invalidate);
		signal.addEventListener(
			"abort",
			() => {
				for (const event of NOTEBOOK_MODEL_CHANGE_EVENTS) model.off(event, invalidate);
				this.#views.clear();
			},
			{ once: true },
		);
	}

	open(kind: ViewKind, signal: AbortSignal): ReadbackView {
		const view = {};
		this.#views.set(view, { kind, version: 0, settled: new Set(), closed: false });
		signal.addEventListener("abort", () => this.close(view), { once: true });
		return view;
	}

	close(view: ReadbackView): void {
		const state = this.#views.get(view);
		if (!state) return;
		state.closed = true;
		state.version += 1;
		state.settled.clear();
		this.#views.delete(view);
	}

	start(view: ReadbackView): ReadbackAttempt {
		const state = this.#views.get(view);
		if (!state || state.closed) throw new Error("Cannot start a closed notebook view");
		state.version += 1;
		state.settled.clear();
		return { view, generation: this.#generation, version: state.version };
	}

	cancel(attempt: ReadbackAttempt): void {
		const state = this.#current(attempt);
		if (!state) return;
		state.version += 1;
		state.settled.clear();
	}

	read(index: number): CellReadback {
		return normalizeCellReadback(this.#cells[String(index)]);
	}

	publish(attempt: ReadbackAttempt, index: number, value: CellReadback): void {
		const state = this.#current(attempt);
		if (!state) return;
		state.settled.add(index);
		const key = String(index);
		if (sameWireValue(this.#cells[key], value)) return;
		this.#cells = { ...this.#cells, [key]: value };
		this.#model.set("_cell_values", this.#cells);
		this.#model.save_changes();
	}

	completeFullView(attempt: ReadbackAttempt, cellCount: number): void {
		const state = this.#current(attempt);
		if (!state || state.kind !== "full" || state.settled.size !== cellCount) return;
		markRendered(this.#model);
	}

	isCurrent(attempt: ReadbackAttempt): boolean {
		return this.#current(attempt) !== undefined;
	}

	#current(attempt: ReadbackAttempt): ViewState | undefined {
		if (attempt.generation !== this.#generation) return undefined;
		const state = this.#views.get(attempt.view);
		if (!state || state.closed || state.version !== attempt.version) return undefined;
		return state;
	}

	#invalidate(): void {
		this.#generation += 1;
		for (const state of this.#views.values()) {
			state.version += 1;
			state.settled.clear();
		}
		this.#cells = {};
		let changed = false;
		if (this.#model.get("_has_rendered") !== false) {
			this.#model.set("_has_rendered", false);
			changed = true;
		}
		if (!sameWireValue(this.#model.get("_cell_values"), {})) {
			this.#model.set("_cell_values", {});
			changed = true;
		}
		if (!sameWireValue(this.#model.get("_graph"), {})) {
			this.#model.set("_graph", {} as NotebookGraph);
			changed = true;
		}
		if (changed) this.#model.save_changes();
	}
}

export function markRendered(model: AnyWidgetModel): void {
	if (model.get("_has_rendered") === true) return;
	model.set("_has_rendered", true);
	model.save_changes();
}

export function syncNotebookGraph(
	model: AnyWidgetModel,
	notebook: Notebook,
	keys: readonly string[] = [],
	analysis?: NotebookAnalysis,
): void {
	const graph = analysis ? createNotebookGraphFromAnalysis(analysis, keys) : createNotebookGraph(notebook, keys);
	if (!sameWireValue(model.get("_graph"), graph)) {
		model.set("_graph", graph);
		model.save_changes();
	}
}

export function readNotebookRuntimeValues(model: AnyWidgetModel): Record<string, unknown> {
	const owners = new Map<string, { count: number; value: unknown }>();
	for (const raw of Object.values(readCellReadbacks(model))) {
		const record = normalizeCellReadback(raw);
		if (!record.rendered) continue;
		for (const [name, value] of Object.entries(record.values)) {
			const current = owners.get(name);
			owners.set(name, { count: (current?.count ?? 0) + 1, value });
		}
	}
	return Object.fromEntries(
		[...owners.entries()].filter(([, owner]) => owner.count === 1).map(([name, owner]) => [name, owner.value]),
	);
}

function readCellReadbacks(model: AnyWidgetModel): NonNullable<WidgetModel["_cell_values"]> {
	const value = model.get("_cell_values");
	if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
	return value;
}

function normalizeCellReadback(value: unknown): CellReadback {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return EMPTY_CELL_READBACK;
	const record = value as { rendered?: unknown; names?: unknown; values?: unknown };
	const names = Array.isArray(record.names)
		? record.names.filter((name): name is string => typeof name === "string")
		: [];
	const values =
		record.values !== null && typeof record.values === "object" && !Array.isArray(record.values)
			? (record.values as Record<string, unknown>)
			: {};
	return { rendered: record.rendered === true, names, values };
}
