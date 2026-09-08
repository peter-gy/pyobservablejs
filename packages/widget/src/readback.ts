import { isNumber } from "@pyobservablejs/runtime/values";
import { createDiagnostic, errorDetails, type Diagnostic, type NotebookState } from "@pyobservablejs/runtime";
import { readCaptureState, type AnyWidgetModel, type WidgetModel } from "./model";
import { createWireBudget, sameWireValue, toWireValue, type WireBudget, type WireValues } from "./values";

type ReadbackState = NonNullable<WidgetModel["_readback"]>;
type CellReadback = ReadbackState["results"][string];
type ErrorPhase = CellReadback["errors"][number]["phase"];
type CachedCell = {
	revision: number;
	status: CellReadback["status"];
	available: WireBudget;
	remaining: WireBudget;
	value: CellReadback;
	diagnostics: readonly Diagnostic[];
};

export class ReadbackPublisher {
	readonly captureState: boolean;
	readonly #model: AnyWidgetModel;
	#transportRevision: number;
	#inputRevision: number | null;
	#generation = 0;
	#closed = false;
	#cells = new Map<string, CachedCell>();
	#graph: NotebookState["graph"] = null;
	#wireGraph: ReadbackState["graph"] = {};
	#pending: ReadbackState | undefined;
	#scheduled = false;

	constructor(
		model: AnyWidgetModel,
		signal: AbortSignal,
		private readonly diagnostics?: {
			update(errors: readonly Diagnostic[]): void;
			fail(cause: unknown): void;
		},
	) {
		this.#model = model;
		this.captureState = readCaptureState(model);
		const current = model.get("_readback");
		this.#transportRevision = safeRevision(current?.revision) ?? 0;
		this.#inputRevision = safeRevision(current?.input_revision);
		signal.addEventListener(
			"abort",
			() => {
				this.#closed = true;
				this.#generation += 1;
				this.#cells.clear();
				this.#pending = undefined;
			},
			{ once: true },
		);
	}

	start(): (state: NotebookState) => void {
		const previous = this.#pending ?? this.#model.get("_readback");
		this.#pending = undefined;
		this.#graph = null;
		this.#wireGraph = {};
		this.#cells.clear();
		const generation = ++this.#generation;
		const offset = (this.#inputRevision ?? -1) + 1;
		if (this.captureState && previous?.input_revision !== null && previous?.input_revision !== undefined) {
			const results = Object.fromEntries(
				Object.keys(previous.results).map((index) => [
					index,
					{
						revision: offset,
						status: "pending" as const,
						values: {},
						errors: [],
					},
				]),
			);
			const pending = Object.keys(results).length > 0;
			this.#enqueue({
				revision: 0,
				input_revision: offset,
				settled_revision: pending ? previous.settled_revision : offset,
				pending,
				graph: {},
				results,
				errors: [],
			});
		}
		return (state) => {
			if (this.#closed || !this.captureState || generation !== this.#generation || state.inputRevision === null) return;
			const budget = createWireBudget();
			const cells = new Map<string, CachedCell>();
			const results = Object.fromEntries(
				Object.entries(state.results).map(([index, result]) => {
					const cell = this.#serializeCell(index, result, offset, budget);
					cells.set(index, cell);
					return [index, cell.value];
				}),
			);
			this.#cells = cells;
			this.diagnostics?.update([...cells.values()].flatMap((cell) => cell.diagnostics));
			this.#enqueue({
				revision: 0,
				input_revision: state.inputRevision + offset,
				settled_revision: state.settledRevision === null ? null : state.settledRevision + offset,
				pending: state.pending,
				graph: this.#serializeGraph(state.graph),
				results,
				errors: [...state.errors],
			});
		};
	}

	fail<Cause>(cause: Cause): void {
		if (this.#closed || !this.captureState) return;
		this.#generation += 1;
		this.#cells.clear();
		const revision = (this.#inputRevision ?? -1) + 1;
		this.#enqueue({
			revision: 0,
			input_revision: revision,
			settled_revision: revision,
			pending: false,
			graph: {},
			results: {},
			errors: [structuredError(cause, "rendering")],
		});
	}

	snapshot(): ReadbackState {
		this.#flush();
		const snapshot = this.#model.get("_readback");
		if (!snapshot) throw new Error("View readback is unavailable");
		return snapshot;
	}

	#flush(): void {
		const pending = this.#pending;
		this.#pending = undefined;
		if (pending && !this.#closed) {
			try {
				this.#save(pending);
			} catch (cause) {
				this.diagnostics?.fail(cause);
			}
		}
	}

	#serializeGraph(graph: NotebookState["graph"]): ReadbackState["graph"] {
		if (graph !== this.#graph) {
			this.#graph = graph;
			this.#wireGraph = graph
				? {
						cells: graph.cells.map(({ runtimeOutputs, ...cell }) => ({
							...cell,
							runtime_outputs: runtimeOutputs,
						})),
						edges: graph.edges,
					}
				: {};
		}
		return this.#wireGraph;
	}

	#enqueue(state: ReadbackState): void {
		this.#inputRevision = state.input_revision;
		this.#pending = state;
		if (this.#scheduled) return;
		this.#scheduled = true;
		// Capture native values synchronously, then publish one complete wire snapshot.
		queueMicrotask(() => {
			this.#scheduled = false;
			this.#flush();
		});
	}

	#serializeCell(
		index: string,
		result: NotebookState["results"][number],
		offset: number,
		budget: WireBudget,
	): CachedCell {
		const cached = this.#cells.get(index);
		// Runtime cells publish pending before replacing captured values.
		// Budget equality also invalidates summaries when preceding cells change size.
		if (
			cached?.revision === result.revision &&
			cached.status === result.status &&
			cached.available.nodes === budget.nodes &&
			cached.available.bytes === budget.bytes
		) {
			Object.assign(budget, cached.remaining);
			return cached;
		}
		const available = { ...budget };
		const values: WireValues = {};
		const errors: CellReadback["errors"] = [...result.errors];
		const diagnostics: Diagnostic[] = [];
		for (const [name, value] of Object.entries(result.values)) {
			try {
				Object.defineProperty(values, name, {
					value: toWireValue(value, budget),
					enumerable: true,
					configurable: true,
					writable: true,
				});
			} catch (cause) {
				const inspected = this.#model.get("_inspection")?.value?.cells.find((cell) => cell.index === Number(index));
				const cell = inspected
					? {
							index: inspected.index,
							id: inspected.id,
							key: inspected.key,
							mode: inspected.mode,
							source: inspected.source,
						}
					: undefined;
				const diagnostic = createDiagnostic(cause, {
					origin: "widget",
					phase: "serialization",
					component: "packages/widget/src/values.ts",
					operation: "serialize cell value",
					variable: name,
					cell,
				});
				diagnostics.push(diagnostic);
				errors.push({ ...errorDetails(cause), phase: "serialization", variable: name });
			}
		}
		const value: CellReadback = {
			revision: result.revision + offset,
			status: errors.length ? "error" : result.status,
			values,
			errors,
		};
		return {
			revision: result.revision,
			status: result.status,
			available,
			remaining: { ...budget },
			value,
			diagnostics,
		};
	}

	#save(state: ReadbackState): void {
		const current = this.#model.get("_readback");
		if (current && sameWireValue({ ...current, revision: 0 }, state)) return;
		this.#inputRevision = state.input_revision;
		state.revision = ++this.#transportRevision;
		this.#model.set("_readback", state);
		this.#model.save_changes();
	}
}

function safeRevision(value: number | null | undefined): number | null {
	return isNumber(value) && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function structuredError<Cause>(cause: Cause, phase: ErrorPhase): ReadbackState["errors"][number] {
	return { ...errorDetails(cause), phase };
}
