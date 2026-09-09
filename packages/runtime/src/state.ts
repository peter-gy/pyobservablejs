import { createNotebookGraphFromAnalysis, type NotebookAnalysis, type NotebookGraph } from "./graph";
import type { Variables } from "./values";
import { errorDetails, type ErrorDetail } from "./diagnostics";

export type ErrorPhase = "analysis" | "evaluation" | "rendering";
export type CellStatus = "pending" | "success" | "error";

export type CellError = ErrorDetail &
	Readonly<{
		phase: ErrorPhase;
		variable?: string;
	}>;

export type NotebookError = ErrorDetail &
	Readonly<{
		phase: ErrorPhase;
	}>;

export type CellResult = Readonly<{
	revision: number;
	status: CellStatus;
	values: Readonly<Variables>;
	errors: readonly CellError[];
}>;

export type EvaluationAttempt = number;

export type EvaluationToken = {
	attempt: EvaluationAttempt;
	revision: number;
	index: number;
	channel: string;
	generation: number;
};

export type NotebookState = Readonly<{
	inputRevision: number | null;
	settledRevision: number | null;
	pending: boolean;
	graph: NotebookGraph | null;
	results: Readonly<Record<number, CellResult>>;
	errors: readonly NotebookError[];
}>;
type CellResults = Record<number, CellResult>;

/** Track render attempts and publish native evaluation state. */
export class EvaluationState {
	readonly #onState?: (state: NotebookState) => void;
	#state: NotebookState = Object.freeze({
		inputRevision: null,
		settledRevision: null,
		pending: false,
		graph: null,
		results: Object.freeze({}),
		errors: Object.freeze([]),
	});
	readonly #captureState: boolean;
	#results: CellResults = {};
	#graph: NotebookGraph | null = null;
	#errors: NotebookError[] = [];
	#inputRevision: number | null = null;
	#settledRevision: number | null = null;
	#pending = new Set<number>();
	#selected = new Set<number>();
	#attempt = 0;
	#closed = false;
	#channelGenerations = new Map<string, number>();
	#minimumTokenRevisions = new Map<number, number>();
	#settlementGeneration = 0;
	#listeners = new Set<() => void>();

	constructor(captureState: boolean, signal: AbortSignal, onState?: (state: NotebookState) => void) {
		this.#captureState = captureState;
		this.#onState = onState;
		signal.addEventListener("abort", () => this.close(), { once: true });
	}

	get state(): NotebookState {
		return this.#state;
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#attempt += 1;
		this.#pending.clear();
		this.#settlementGeneration += 1;
		this.#listeners.clear();
	}

	start(): EvaluationAttempt {
		if (this.#closed) throw new Error("Cannot start a closed notebook mount");
		this.#settlementGeneration += 1;
		this.#channelGenerations.clear();
		this.#minimumTokenRevisions.clear();
		return ++this.#attempt;
	}

	isCurrent(attempt: EvaluationAttempt): boolean {
		return !this.#closed && attempt === this.#attempt;
	}

	get captureState(): boolean {
		return this.#captureState;
	}

	invalidate(publishPending = false): void {
		if (this.#closed) return;
		this.#attempt += 1;
		this.#settlementGeneration += 1;
		this.#errors = [];
		if (publishPending && this.#captureState && this.#inputRevision !== null) this.#openRevision(this.#selected);
	}

	syncGraph(
		attempt: EvaluationAttempt,
		analysis: NotebookAnalysis,
		includedIndexes: ReadonlySet<number>,
		keys: readonly string[] = [],
	): void {
		if (!this.#isCapturing(attempt)) return;
		const fullGraph = createNotebookGraphFromAnalysis(analysis, keys);
		const cells = fullGraph.cells.filter((cell) => includedIndexes.has(cell.index));
		const cellIds = new Set(cells.map((cell) => cell.id));
		this.#graph = {
			cells,
			edges: fullGraph.edges.filter((edge) => cellIds.has(edge.from) && cellIds.has(edge.to)),
		};
		this.#graph =
			this.#graph === null
				? null
				: Object.freeze({
						cells: Object.freeze(
							this.#graph.cells.map((cell) =>
								Object.freeze({
									...cell,
									defines: Object.freeze([...cell.defines]),
									references: Object.freeze([...cell.references]),
									outputs: Object.freeze([...cell.outputs]),
									runtimeOutputs: Object.freeze([...cell.runtimeOutputs]),
								}),
							),
						),
						edges: Object.freeze(this.#graph.edges.map((edge) => Object.freeze({ ...edge }))),
					});
	}

	begin(attempt: EvaluationAttempt, selectedIndexes: ReadonlySet<number>): void {
		if (!this.#isCapturing(attempt)) return;
		const sameSelection =
			selectedIndexes.size === this.#selected.size && [...selectedIndexes].every((index) => this.#selected.has(index));
		this.#selected = new Set(selectedIndexes);
		if (sameSelection && this.#pending.size > 0) {
			this.#save();
			return;
		}
		this.#openRevision(selectedIndexes);
	}

	beginInput(attempt: EvaluationAttempt, affectedIndexes: ReadonlySet<number>): void {
		if (!this.#isCapturing(attempt)) return;
		this.#openRevision(new Set([...affectedIndexes].filter((index) => this.#selected.has(index))));
	}

	beginCell(attempt: EvaluationAttempt, index: number, channel: string, generation: number): EvaluationToken | null {
		if (!this.#isCapturing(attempt) || !this.#selected.has(index)) return null;
		const channelKey = `${index}:${channel}`;
		const previousGeneration = this.#channelGenerations.get(channelKey) ?? 0;
		if (generation <= previousGeneration) return null;
		this.#channelGenerations.set(channelKey, generation);

		const current = this.#results[index];
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

	settleCell(token: EvaluationToken, result: Omit<CellResult, "revision">): void {
		if (!this.#isCurrentToken(token)) return;
		const revision = this.#requireInputRevision();
		this.#results = {
			...this.#results,
			[String(token.index)]: freezeCellResult({ revision, ...result }),
		};
		this.#pending.delete(token.index);
		if (this.#pending.size > 0) this.#save();
		this.#scheduleSettlement(revision);
	}

	fail<Cause>(attempt: EvaluationAttempt, cause: Cause, phase: ErrorPhase): void {
		if (!this.#isCapturing(attempt)) return;
		if (this.#inputRevision === null) {
			this.#inputRevision = 0;
		} else if (this.#pending.size === 0) {
			this.#inputRevision += 1;
		}
		this.#settledRevision = this.#inputRevision;
		this.#pending.clear();
		this.#results = {};
		this.#errors = [structuredError(cause, phase)];
		this.#save();
	}

	#openRevision(affectedIndexes: ReadonlySet<number>): void {
		this.#inputRevision = this.#inputRevision === null ? 0 : this.#inputRevision + 1;
		this.#errors = [];
		this.#settlementGeneration += 1;
		const revision = this.#inputRevision;
		const next: CellResults = {};
		const pending = new Set<number>();
		for (const index of this.#selected) {
			const previous = this.#results[index];
			if (affectedIndexes.has(index) || !previous) {
				next[index] = pendingResult(revision);
				pending.add(index);
			} else {
				next[index] = previous;
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

	#isCurrentToken(token: EvaluationToken): boolean {
		return (
			this.isCurrent(token.attempt) &&
			this.#pending.has(token.index) &&
			token.revision >= (this.#minimumTokenRevisions.get(token.index) ?? token.revision) &&
			this.#channelGenerations.get(`${token.index}:${token.channel}`) === token.generation
		);
	}

	#isCapturing(attempt: EvaluationAttempt): boolean {
		return this.#captureState && this.isCurrent(attempt);
	}

	#requireInputRevision(): number {
		if (this.#inputRevision === null) throw new Error("notebook mount evaluation has not started");
		return this.#inputRevision;
	}

	#save(): void {
		if (!this.#captureState) return;

		this.#state = Object.freeze({
			inputRevision: this.#inputRevision,
			settledRevision: this.#settledRevision,
			pending: this.#pending.size > 0,
			graph: this.#graph,
			results: Object.freeze(this.#results),
			errors: Object.freeze(this.#errors.map((error) => Object.freeze({ ...error }))),
		});
		this.#onState?.(this.#state);
		for (const listener of this.#listeners) listener();
	}
}

export function structuredCellError<Cause>(cause: Cause, phase: ErrorPhase, variable?: string): CellError {
	const error = structuredError(cause, phase);
	return variable === undefined ? error : { ...error, variable };
}

function structuredError<Cause>(cause: Cause, phase: ErrorPhase): NotebookError {
	return Object.freeze({ ...errorDetails(cause), phase });
}

function pendingResult(revision: number): CellResult {
	return freezeCellResult({ revision, status: "pending", values: {}, errors: [] });
}

function freezeCellResult(result: CellResult): CellResult {
	return Object.freeze({
		...result,
		values: Object.freeze({ ...result.values }),
		errors: Object.freeze(result.errors.map((error) => Object.freeze({ ...error }))),
	});
}
