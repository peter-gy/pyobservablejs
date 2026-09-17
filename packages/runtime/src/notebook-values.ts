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
	#cells = new Map<number, Set<string>>();
	#names = new Map<string | null, Set<string>>();
	#primary = new Map<number, ReadonlySet<string | null>>();
	#listeners = new Map<string, Set<() => void>>();
	#settlers = new Set<() => void>();
	#pending = 0;
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
		this.#cells.clear();
		this.#names.clear();
		this.#primary.clear();
		this.#pending = 0;
		this.#epoch++;
		this.#notify();
	}

	register(cell: number, names: readonly string[], primary: readonly string[] = names): void {
		this.#primary.set(cell, new Set(primary.length ? primary : [null]));
		for (const name of names.length ? names : [null]) this.pending(cell, name);
	}

	invalidate(cells: ReadonlySet<number>): void {
		this.#epoch++;
		for (const cell of cells) {
			for (const key of this.#cells.get(cell) ?? []) {
				const entry = this.#entries.get(key)!;
				this.pending(entry.cell, entry.name);
			}
		}
		this.#notify();
	}

	pending(cell: number, name: string | null): void {
		this.#set({ cell, name, revision: ++this.#revision, status: "pending" });
	}

	fulfilled(cell: number, name: string | null, value: RuntimeValue): void {
		this.#set({ cell, name, revision: ++this.#revision, status: "success", value });
	}

	rejected<Cause>(cell: number, name: string | null, cause: Cause, diagnostic?: Diagnostic): void {
		const error = diagnostic
			? new DiagnosticError(diagnostic, isObjectValue(cause) ? cause : undefined)
			: cause instanceof Error
				? cause
				: new Error(errorDetails(cause).message);
		this.#set({ cell, name, revision: ++this.#revision, status: "error", error });
	}

	fail<Cause>(cell: number, cause: Cause, diagnostic?: Diagnostic): void {
		for (const key of this.#cells.get(cell) ?? []) {
			const entry = this.#entries.get(key)!;
			this.rejected(cell, entry.name, cause, diagnostic);
		}
	}

	async settle(signal: AbortSignal): Promise<void> {
		const epoch = this.#epoch;
		await new Promise<void>((resolve, reject) => {
			const cleanup = () => {
				this.#settlers.delete(check);
				signal.removeEventListener("abort", check);
			};
			const check = () => {
				if (signal.aborted) {
					cleanup();
					reject(signal.reason);
				} else if (epoch !== this.#epoch || this.#pending === 0) {
					cleanup();
					resolve();
				}
			};
			this.#settlers.add(check);
			signal.addEventListener("abort", check, { once: true });
			check();
		});
		signal.throwIfAborted();
	}
	get isPending(): boolean {
		return this.#pending > 0;
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
		const keys = query.cell === undefined ? this.#names.get(query.name ?? null) : this.#cells.get(query.cell);
		let selected: ValueEntry | undefined;
		for (const key of keys ?? []) {
			const entry = this.#entries.get(key)!;
			if (query.name === undefined && !this.#primary.get(entry.cell)?.has(entry.name)) continue;
			if (query.name !== undefined && query.name !== entry.name) continue;
			if (selected) throw new Error("Value selection is ambiguous. Specify both cell and name");
			selected = entry;
		}
		if (!selected) throw new Error("Value is outside the evaluated selection or is not defined");
		return selected;
	}

	wait(selector: ValueSelector, signal: AbortSignal, revision?: number): Promise<ValueEntry> {
		const epoch = this.#epoch;
		let target: { cell: number; name: string | null } | undefined;
		let key: string | undefined;
		return new Promise((resolve, reject) => {
			const cleanup = () => {
				if (key !== undefined) {
					const listeners = this.#listeners.get(key);
					listeners?.delete(check);
					if (!listeners?.size) this.#listeners.delete(key);
				}
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
						if (!target) {
							target = { cell: entry.cell, name: entry.name };
							key = valueKey(entry.cell, entry.name);
							let listeners = this.#listeners.get(key);
							if (!listeners) this.#listeners.set(key, (listeners = new Set()));
							listeners.add(check);
						}
						return;
					}
					cleanup();
					resolve(entry);
				} catch (cause) {
					fail(cause instanceof Error ? cause : new Error(String(cause)));
				}
			};
			signal.addEventListener("abort", onAbort, { once: true });
			check();
		});
	}

	#set(entry: ValueEntry): void {
		const key = valueKey(entry.cell, entry.name);
		// Membership is stable through settlements; indexes retain keys, not stale entries.
		if (!this.#entries.has(key)) {
			let cells = this.#cells.get(entry.cell);
			if (!cells) this.#cells.set(entry.cell, (cells = new Set()));
			cells.add(key);
			let names = this.#names.get(entry.name);
			if (!names) this.#names.set(entry.name, (names = new Set()));
			names.add(key);
		}
		if (this.#entries.get(key)?.status === "pending") this.#pending--;
		if (entry.status === "pending") this.#pending++;
		this.#entries.set(key, entry);
		this.#notify(key);
	}

	#notify(key?: string): void {
		this.#catalogDirty = true;
		// A completion only concerns readers of that value. Epoch changes invalidate all reads.
		if (key === undefined) {
			for (const listeners of this.#listeners.values()) for (const listener of listeners) listener();
		} else {
			for (const listener of this.#listeners.get(key) ?? []) listener();
		}
		for (const listener of this.#settlers) listener();
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
