import { createNotebookGraphFromAnalysis, sameWireValue, type NotebookAnalysis } from "@pyobservablejs/runtime";
import { isRecord, type AnyWidgetModel, type WidgetModel } from "./model";

export type ErrorPhase = "analysis" | "evaluation" | "rendering" | "serialization";
export type CellStatus = "pending" | "success" | "error";

export type CellErrorWire = {
	name: string;
	message: string;
	phase: ErrorPhase;
	variable?: string;
};

export type ViewErrorWire = {
	name: string;
	message: string;
	phase: ErrorPhase;
};

export type CellReadback = {
	revision: number;
	status: CellStatus;
	values: Record<string, unknown>;
	errors: CellErrorWire[];
};

export type ReadbackAttempt = number;

export type ReadbackToken = {
	attempt: ReadbackAttempt;
	revision: number;
	index: number;
	channel: string;
	generation: number;
};

type ReadbackState = NonNullable<WidgetModel["_readback"]>;
type CellReadbacks = ReadbackState["results"];

/** Publish one NotebookView's complete evaluation state. */
export class ViewReadback {
	readonly #model: AnyWidgetModel;
	#results: CellReadbacks = {};
	#graph: ReadbackState["graph"] = {};
	#errors: ViewErrorWire[] = [];
	#transportRevision: number;
	#inputRevision: number | null;
	#settledRevision: number | null;
	#pending = new Set<number>();
	#selected = new Set<number>();
	#attempt = 0;
	#closed = false;
	#channelGenerations = new Map<string, number>();
	#minimumTokenRevisions = new Map<number, number>();
	#settlementGeneration = 0;

	constructor(model: AnyWidgetModel, signal: AbortSignal) {
		this.#model = model;
		const current = readState(model.get("_readback"));
		this.#transportRevision = current.revision;
		this.#inputRevision = current.input_revision;
		this.#settledRevision = current.settled_revision;
		this.#graph = current.graph;
		this.#results = current.results;
		this.#errors = current.errors;
		for (const [index, result] of Object.entries(current.results)) {
			this.#selected.add(Number(index));
			if (result.status === "pending") this.#pending.add(Number(index));
		}
		signal.addEventListener("abort", () => this.close(), { once: true });
		this.invalidate(true);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#attempt += 1;
		this.#pending.clear();
		this.#settlementGeneration += 1;
	}

	start(): ReadbackAttempt {
		if (this.#closed) throw new Error("Cannot start a closed NotebookView");
		this.#settlementGeneration += 1;
		this.#channelGenerations.clear();
		this.#minimumTokenRevisions.clear();
		return ++this.#attempt;
	}

	cancel(attempt: ReadbackAttempt): void {
		if (!this.isCurrent(attempt)) return;
		this.#attempt += 1;
		this.#settlementGeneration += 1;
	}

	isCurrent(attempt: ReadbackAttempt): boolean {
		return !this.#closed && attempt === this.#attempt;
	}

	invalidate(publishPending = false): void {
		if (this.#closed) return;
		this.#attempt += 1;
		this.#settlementGeneration += 1;
		this.#graph = {};
		this.#errors = [];
		if (publishPending && this.#inputRevision !== null) this.#openRevision(this.#selected);
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
		this.#graph = {
			cells,
			edges: fullGraph.edges.filter((edge) => cellIds.has(edge.from) && cellIds.has(edge.to)),
		};
	}

	begin(attempt: ReadbackAttempt, selectedIndexes: ReadonlySet<number>): void {
		if (!this.isCurrent(attempt)) return;
		const sameSelection =
			selectedIndexes.size === this.#selected.size && [...selectedIndexes].every((index) => this.#selected.has(index));
		this.#selected = new Set(selectedIndexes);
		if (sameSelection && this.#pending.size > 0) {
			this.#save();
			return;
		}
		this.#openRevision(selectedIndexes);
	}

	beginInput(attempt: ReadbackAttempt, affectedIndexes: ReadonlySet<number>): void {
		if (!this.isCurrent(attempt)) return;
		this.#openRevision(new Set([...affectedIndexes].filter((index) => this.#selected.has(index))));
	}

	beginCell(attempt: ReadbackAttempt, index: number, channel: string, generation: number): ReadbackToken | null {
		if (!this.isCurrent(attempt) || !this.#selected.has(index)) return null;
		const channelKey = `${index}:${channel}`;
		const previousGeneration = this.#channelGenerations.get(channelKey) ?? 0;
		if (generation <= previousGeneration) return null;
		this.#channelGenerations.set(channelKey, generation);

		const current = this.#results[String(index)];
		if (this.#inputRevision === null || !this.#pending.size) {
			this.#openRevision(new Set([index]));
		} else if (current?.status !== "pending") {
			this.#pending.add(index);
			this.#results = {
				...this.#results,
				[String(index)]: pendingResult(this.#requireInputRevision()),
			};
			this.#save();
		}
		return {
			attempt,
			revision: this.#requireInputRevision(),
			index,
			channel,
			generation,
		};
	}

	settleCell(token: ReadbackToken, result: Omit<CellReadback, "revision">): void {
		if (!this.#isCurrentToken(token)) return;
		const revision = this.#requireInputRevision();
		this.#results = {
			...this.#results,
			[String(token.index)]: { revision, ...result },
		};
		this.#pending.delete(token.index);
		if (this.#pending.size > 0) this.#save();
		this.#scheduleSettlement(revision);
	}

	fail(attempt: ReadbackAttempt, error: unknown, phase: ErrorPhase): void {
		if (!this.isCurrent(attempt)) return;
		if (this.#inputRevision === null) {
			this.#inputRevision = 0;
		} else if (this.#pending.size === 0) {
			this.#inputRevision += 1;
		}
		this.#settledRevision = this.#inputRevision;
		this.#pending.clear();
		this.#results = {};
		this.#errors = [structuredError(error, phase)];
		this.#save();
	}

	#openRevision(affectedIndexes: ReadonlySet<number>): void {
		this.#inputRevision = this.#inputRevision === null ? 0 : this.#inputRevision + 1;
		this.#errors = [];
		this.#settlementGeneration += 1;
		const revision = this.#inputRevision;
		const next: CellReadbacks = {};
		const pending = new Set<number>();
		for (const index of this.#selected) {
			const previous = this.#results[String(index)];
			if (affectedIndexes.has(index) || !previous) {
				next[String(index)] = pendingResult(revision);
				pending.add(index);
			} else {
				next[String(index)] = previous;
				// A disjoint input can arrive while this cell is still evaluating.
				// Keep its token valid so that work can finish in the new revision.
				if (previous.status === "pending") pending.add(index);
			}
		}
		this.#results = next;
		this.#pending = pending;
		for (const index of affectedIndexes) this.#minimumTokenRevisions.set(index, revision);
		if (this.#pending.size === 0) this.#settledRevision = revision;
		this.#save();
	}

	#scheduleSettlement(revision: number): void {
		if (this.#pending.size > 0) return;
		const generation = ++this.#settlementGeneration;
		queueMicrotask(() => {
			if (
				this.#closed ||
				generation !== this.#settlementGeneration ||
				this.#inputRevision !== revision ||
				this.#pending.size > 0
			) {
				return;
			}
			this.#settledRevision = revision;
			this.#save();
		});
	}

	#isCurrentToken(token: ReadbackToken): boolean {
		return (
			this.isCurrent(token.attempt) &&
			this.#pending.has(token.index) &&
			token.revision >= (this.#minimumTokenRevisions.get(token.index) ?? token.revision) &&
			this.#channelGenerations.get(`${token.index}:${token.channel}`) === token.generation
		);
	}

	#requireInputRevision(): number {
		if (this.#inputRevision === null) throw new Error("NotebookView evaluation has not started");
		return this.#inputRevision;
	}

	#save(): void {
		const state: ReadbackState = {
			revision: ++this.#transportRevision,
			input_revision: this.#inputRevision,
			settled_revision: this.#settledRevision,
			pending: this.#pending.size > 0,
			graph: this.#graph,
			results: this.#results,
			errors: this.#errors,
		};
		const current = readState(this.#model.get("_readback"));
		if (sameReadbackState(current, state)) return;
		this.#model.set("_readback", state);
		this.#model.save_changes();
	}
}

export function structuredCellError(error: unknown, phase: ErrorPhase, variable?: string): CellErrorWire {
	return { ...structuredError(error, phase), ...(variable === undefined ? {} : { variable }) };
}

export function structuredError(error: unknown, phase: ErrorPhase): ViewErrorWire {
	if (error instanceof Error) return { name: error.name || "Error", message: error.message, phase };
	return { name: "Error", message: String(error), phase };
}

function pendingResult(revision: number): CellReadback {
	return { revision, status: "pending", values: {}, errors: [] };
}

function readState(value: unknown): ReadbackState {
	if (!isRecord(value)) return emptyState();
	const revision = safeRevision(value.revision) ?? 0;
	const inputRevision = optionalRevision(value.input_revision);
	const settledRevision = optionalRevision(value.settled_revision);
	const results = isRecord(value.results) ? normalizeResults(value.results) : {};
	const errors = Array.isArray(value.errors) ? value.errors.filter(isViewErrorWire) : [];
	return {
		revision,
		input_revision: inputRevision,
		settled_revision: settledRevision,
		pending: value.pending === true,
		graph: isRecord(value.graph) ? (value.graph as ReadbackState["graph"]) : {},
		results,
		errors,
	};
}

function emptyState(): ReadbackState {
	return {
		revision: 0,
		input_revision: null,
		settled_revision: null,
		pending: false,
		graph: {},
		results: {},
		errors: [],
	};
}

function normalizeResults(value: Record<string, unknown>): CellReadbacks {
	return Object.fromEntries(
		Object.entries(value).flatMap(([index, item]) => {
			const result = normalizeResult(item);
			return result ? [[index, result]] : [];
		}),
	);
}

function normalizeResult(value: unknown): CellReadback | null {
	if (!isRecord(value)) return null;
	const revision = safeRevision(value.revision);
	const status = value.status;
	if (revision === null || (status !== "pending" && status !== "success" && status !== "error")) return null;
	return {
		revision,
		status,
		values: isRecord(value.values) ? value.values : {},
		errors: Array.isArray(value.errors) ? value.errors.filter(isCellErrorWire) : [],
	};
}

function isCellErrorWire(value: unknown): value is CellErrorWire {
	if (!isRecord(value) || !isStructuredError(value)) return false;
	const variable = (value as Record<string, unknown>).variable;
	return variable === undefined || typeof variable === "string";
}

function isViewErrorWire(value: unknown): value is ViewErrorWire {
	return isStructuredError(value);
}

function isStructuredError(value: unknown): value is ViewErrorWire {
	return (
		isRecord(value) &&
		typeof value.name === "string" &&
		typeof value.message === "string" &&
		(value.phase === "analysis" ||
			value.phase === "evaluation" ||
			value.phase === "rendering" ||
			value.phase === "serialization")
	);
}

function optionalRevision(value: unknown): number | null {
	return value === null ? null : safeRevision(value);
}

function safeRevision(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function sameReadbackState(left: ReadbackState, right: ReadbackState): boolean {
	return (
		left.input_revision === right.input_revision &&
		left.settled_revision === right.settled_revision &&
		left.pending === right.pending &&
		sameWireValue(left.graph, right.graph) &&
		sameWireValue(left.results, right.results) &&
		sameWireValue(left.errors, right.errors)
	);
}
