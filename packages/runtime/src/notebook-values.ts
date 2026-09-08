import { describeDataset, type DatasetDescription } from "./datasets";
import type { RuntimeValue } from "./values";
import { isNumber, isObjectValue, isString } from "./value-kind";
import { DiagnosticError, errorDetails, type Diagnostic } from "./diagnostics";

export type ValueSelector = string | { cell?: number; name?: string | null; path?: readonly (string | number)[] };
export type DatasetInfo = DatasetDescription & Readonly<{ cell: number; name: string | null; revision: number }>;
export type ValueEntry = {
	cell: number;
	name: string | null;
	revision: number;
	status: "pending" | "success" | "error";
	value?: RuntimeValue;
	error?: Error;
};

const datasetOwners = new WeakMap<object, NotebookValues>();

export class NotebookValues {
	#entries = new Map<string, ValueEntry>();
	#primary = new Map<number, ReadonlySet<string | null>>();
	#listeners = new Set<() => void>();
	#revision = 0;
	#epoch = 0;
	#datasetCache = new WeakMap<ValueEntry, DatasetInfo | null>();
	#snapshot: readonly DatasetInfo[] = Object.freeze([]);
	#published: readonly DatasetInfo[] = this.#snapshot;
	#scheduled = false;
	#catalogDirty = true;

	constructor(private readonly onDatasets?: (datasets: readonly DatasetInfo[]) => void) {}

	reset(): void {
		this.#entries.clear();
		this.#primary.clear();
		this.#epoch++;
		this.#notify();
	}

	register(cell: number, names: readonly string[], primary: readonly string[] = names): void {
		this.#primary.set(cell, new Set(primary.length ? primary : [null]));
		for (const name of names.length ? names : [null]) this.pending(cell, name);
	}

	invalidate(cells: ReadonlySet<number>): void {
		this.#epoch++;
		for (const entry of this.#entries.values()) {
			if (cells.has(entry.cell)) this.pending(entry.cell, entry.name);
		}
		this.#notify();
	}

	pending(cell: number, name: string | null): void {
		this.#entries.set(valueKey(cell, name), { cell, name, revision: ++this.#revision, status: "pending" });
		this.#notify();
	}

	fulfilled(cell: number, name: string | null, value: RuntimeValue): void {
		this.#entries.set(valueKey(cell, name), { cell, name, revision: ++this.#revision, status: "success", value });
		this.#notify();
	}

	rejected<Cause>(cell: number, name: string | null, cause: Cause, diagnostic?: Diagnostic): void {
		const error = diagnostic
			? new DiagnosticError(diagnostic, isObjectValue(cause) ? cause : undefined)
			: cause instanceof Error
				? cause
				: new Error(errorDetails(cause).message);
		this.#entries.set(valueKey(cell, name), { cell, name, revision: ++this.#revision, status: "error", error });
		this.#notify();
	}

	fail<Cause>(cell: number, cause: Cause, diagnostic?: Diagnostic): void {
		for (const entry of this.#entries.values())
			if (entry.cell === cell) this.rejected(cell, entry.name, cause, diagnostic);
	}

	datasets(): readonly DatasetInfo[] {
		if (!this.#catalogDirty) return this.#snapshot;
		const datasets: DatasetInfo[] = [];
		for (const entry of this.#entries.values()) {
			if (entry.status !== "success") continue;
			let dataset = this.#datasetCache.get(entry);
			if (dataset === undefined) {
				const description = describeDataset(entry.value);
				dataset = description
					? Object.freeze({ ...description, cell: entry.cell, name: entry.name, revision: entry.revision })
					: null;
				if (dataset) datasetOwners.set(dataset, this);
				this.#datasetCache.set(entry, dataset);
			}
			if (dataset) datasets.push(dataset);
		}
		if (
			datasets.length !== this.#snapshot.length ||
			datasets.some((dataset, index) => dataset !== this.#snapshot[index])
		)
			this.#snapshot = Object.freeze(datasets);
		this.#catalogDirty = false;
		return this.#snapshot;
	}

	entry(selector: ValueSelector): ValueEntry {
		if (isObjectValue(selector) && datasetOwners.has(selector) && datasetOwners.get(selector) !== this)
			throw new Error("Dataset belongs to another notebook mount");
		const query = isString(selector) ? { name: selector } : selector;
		if (query.cell === undefined && query.name === undefined)
			throw new Error("A value selector needs a cell or variable name");
		if (isNumber(query.cell) && (isString(query.name) || query.name === null)) {
			const entry = this.#entries.get(valueKey(query.cell, query.name));
			if (!entry || entry.cell !== query.cell || entry.name !== query.name)
				throw new Error("Value is outside the evaluated selection or is not defined");
			return entry;
		}
		const entries = [...this.#entries.values()].filter(
			(entry) =>
				(query.cell === undefined || query.cell === entry.cell) &&
				(query.name === undefined ? this.#primary.get(entry.cell)?.has(entry.name) : query.name === entry.name),
		);
		if (entries.length === 0) throw new Error("Value is outside the evaluated selection or is not defined");
		if (entries.length !== 1) throw new Error("Value selection is ambiguous. Specify both cell and name");
		return entries[0]!;
	}

	wait(selector: ValueSelector, signal: AbortSignal, revision?: number): Promise<ValueEntry> {
		const epoch = this.#epoch;
		let target: { cell: number; name: string | null } | undefined;
		return new Promise((resolve, reject) => {
			const cleanup = () => {
				this.#listeners.delete(check);
				signal.removeEventListener("abort", onAbort);
			};
			const fail = (error: Error) => {
				cleanup();
				reject(error);
			};
			const onAbort = () => fail(new DOMException("Notebook read cancelled", "AbortError"));
			const check = () => {
				if (signal.aborted) return onAbort();
				if (epoch !== this.#epoch) return fail(new Error("Notebook changed during the read"));
				try {
					const entry = this.entry(target ?? selector);
					if (revision !== undefined && entry.revision !== revision)
						return fail(new Error("Dataset revision is stale"));
					if (entry.status === "error") return fail(entry.error ?? new Error("Notebook value failed"));
					if (entry.status !== "success") {
						target ??= { cell: entry.cell, name: entry.name };
						return;
					}
					cleanup();
					resolve(entry);
				} catch (cause) {
					fail(cause instanceof Error ? cause : new Error(String(cause)));
				}
			};
			this.#listeners.add(check);
			signal.addEventListener("abort", onAbort, { once: true });
			check();
		});
	}

	#notify(): void {
		this.#catalogDirty = true;
		for (const listener of this.#listeners) listener();
		if (!this.onDatasets || this.#scheduled) return;
		this.#scheduled = true;
		queueMicrotask(() => {
			this.#scheduled = false;
			const datasets = this.datasets();
			if (datasets === this.#published) return;
			this.#published = datasets;
			this.onDatasets?.(datasets);
		});
	}
}

function valueKey(cell: number, name: string | null): string {
	return `${cell}:${name ?? ""}`;
}
