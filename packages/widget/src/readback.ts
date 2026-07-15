import {
	createNotebookGraphFromAnalysis,
	sameWireValue,
	type NotebookAnalysis,
	type NotebookGraph,
} from "@pyobservablejs/runtime";
import { isRecord, type AnyWidgetModel, type WidgetModel } from "./model";

export type CellReadback = {
	rendered: boolean;
	names: string[];
	values: Record<string, unknown>;
};

export type ReadbackAttempt = number;

type ReadbackState = NonNullable<WidgetModel["_readback"]>;
type CellReadbacks = ReadbackState["cells"];

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
	#cells: CellReadbacks = {};
	#graph: ReadbackState["graph"] = {};
	#rendered = false;
	#revision: number;
	#attempt = 0;
	#settled = new Set<number>();
	#closed = false;

	constructor(model: AnyWidgetModel, signal: AbortSignal) {
		this.#model = model;
		const current = readState(model.get("_readback"));
		this.#revision = current.revision;
		this.#rendered = current.rendered;
		this.#graph = current.graph;
		this.#cells = current.cells;
		signal.addEventListener("abort", () => this.close(), { once: true });
		this.invalidate();
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#attempt += 1;
		this.#settled.clear();
	}

	start(): ReadbackAttempt {
		if (this.#closed) throw new Error("Cannot start a closed NotebookView");
		this.#settled.clear();
		return ++this.#attempt;
	}

	cancel(attempt: ReadbackAttempt): void {
		if (!this.isCurrent(attempt)) return;
		this.#attempt += 1;
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
		if (this.#rendered) this.#save();
	}

	complete(attempt: ReadbackAttempt, selectedCellCount: number): void {
		if (!this.isCurrent(attempt) || this.#settled.size !== selectedCellCount || this.#rendered) return;
		this.#rendered = true;
		this.#save();
	}

	isCurrent(attempt: ReadbackAttempt): boolean {
		return !this.#closed && attempt === this.#attempt;
	}

	invalidate(): void {
		if (this.#closed) return;
		this.#attempt += 1;
		this.#settled.clear();
		const changed = this.#rendered || Object.keys(this.#cells).length > 0 || Object.keys(this.#graph).length > 0;
		this.#cells = {};
		this.#graph = {};
		this.#rendered = false;
		if (changed) this.#save();
	}

	syncGraph(
		attempt: ReadbackAttempt,
		analysis: NotebookAnalysis,
		includedIndexes: ReadonlySet<number>,
		keys: readonly string[] = [],
	): void {
		if (!this.isCurrent(attempt)) return;
		const fullGraph = createNotebookGraphFromAnalysis(analysis, keys);
		const cells = fullGraph.cells.filter((cell) => includedIndexes.has(cell.index));
		const cellIds = new Set(cells.map((cell) => cell.id));
		const graph: NotebookGraph = {
			cells,
			edges: fullGraph.edges.filter((edge) => cellIds.has(edge.from) && cellIds.has(edge.to)),
		};
		if (sameWireValue(this.#graph, graph)) return;
		this.#graph = graph;
		this.#save();
	}

	#save(): void {
		this.#revision += 1;
		this.#model.set("_readback", {
			revision: this.#revision,
			rendered: this.#rendered,
			graph: this.#graph,
			cells: this.#cells,
		});
		this.#model.save_changes();
	}
}

function readState(value: unknown): ReadbackState {
	if (!isRecord(value)) return { revision: 0, rendered: false, graph: {}, cells: {} };
	const revision =
		typeof value.revision === "number" && Number.isSafeInteger(value.revision) && value.revision >= 0
			? value.revision
			: 0;
	return {
		revision,
		rendered: value.rendered === true,
		graph: isRecord(value.graph) ? (value.graph as ReadbackState["graph"]) : {},
		cells: isRecord(value.cells) ? (value.cells as CellReadbacks) : {},
	};
}

function normalizeCellReadback(value: unknown): CellReadback {
	if (!isRecord(value)) return EMPTY_CELL_READBACK;
	const record = value;
	const names = Array.isArray(record.names)
		? record.names.filter((name): name is string => typeof name === "string")
		: [];
	const values = isRecord(record.values) ? record.values : {};
	return { rendered: record.rendered === true, names, values };
}
