import {
	createNotebookGraphFromAnalysis,
	sameWireValue,
	type NotebookAnalysis,
	type NotebookGraph,
} from "@pyobservablejs/runtime";
import type { AnyWidgetModel, WidgetModel } from "./model";

export type CellReadback = {
	rendered: boolean;
	names: string[];
	values: Record<string, unknown>;
};

export type ReadbackAttempt = {
	generation: number;
	version: number;
};

const EMPTY_CELL_READBACK: CellReadback = {
	rendered: false,
	names: [],
	values: {},
};

/**
 * Publish one NotebookView's derived state and reject writes from superseded
 * runtime attempts. The Notebook session never receives derived readback.
 */
export class ViewReadback {
	readonly #model: AnyWidgetModel;
	#cells: NonNullable<WidgetModel["_cell_values"]>;
	#generation = 0;
	#version = 0;
	#settled = new Set<number>();
	#closed = false;

	constructor(model: AnyWidgetModel, signal: AbortSignal) {
		this.#model = model;
		this.#cells = readCellReadbacks(model);
		signal.addEventListener("abort", () => this.close(), { once: true });
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#version += 1;
		this.#settled.clear();
	}

	start(): ReadbackAttempt {
		if (this.#closed) throw new Error("Cannot start a closed NotebookView");
		this.#version += 1;
		this.#settled.clear();
		return { generation: this.#generation, version: this.#version };
	}

	cancel(attempt: ReadbackAttempt): void {
		if (!this.isCurrent(attempt)) return;
		this.#version += 1;
		this.#settled.clear();
	}

	read(index: number): CellReadback {
		return normalizeCellReadback(this.#cells[String(index)]);
	}

	publish(attempt: ReadbackAttempt, index: number, value: CellReadback): void {
		if (!this.isCurrent(attempt)) return;
		this.#settled.add(index);
		const key = String(index);
		if (sameWireValue(this.#cells[key], value)) return;
		this.#cells = { ...this.#cells, [key]: value };
		this.#model.set("_cell_values", this.#cells);
		this.#model.save_changes();
	}

	complete(attempt: ReadbackAttempt, selectedCellCount: number): void {
		if (!this.isCurrent(attempt) || this.#settled.size !== selectedCellCount) return;
		markRendered(this.#model);
	}

	isCurrent(attempt: ReadbackAttempt): boolean {
		return !this.#closed && attempt.generation === this.#generation && attempt.version === this.#version;
	}

	invalidate(): void {
		if (this.#closed) return;
		this.#generation += 1;
		this.#version += 1;
		this.#settled.clear();
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
	analysis: NotebookAnalysis,
	includedIndexes: ReadonlySet<number>,
	keys: readonly string[] = [],
): void {
	const fullGraph = createNotebookGraphFromAnalysis(analysis, keys);
	const cells = fullGraph.cells.filter((cell) => includedIndexes.has(cell.index));
	const cellIds = new Set(cells.map((cell) => cell.id));
	const graph: NotebookGraph = {
		cells,
		edges: fullGraph.edges.filter((edge) => cellIds.has(edge.from) && cellIds.has(edge.to)),
	};
	if (!sameWireValue(model.get("_graph"), graph)) {
		model.set("_graph", graph);
		model.save_changes();
	}
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
