import type { AnyWidgetModel } from "./model";

export type NotebookViewState = {
	sessionRef: string;
	cellIndexes: number[] | null;
};

export function readNotebookViewState(model: AnyWidgetModel): NotebookViewState {
	const sessionRef = model.get("_notebook");
	if (typeof sessionRef !== "string" || !sessionRef) {
		throw new Error("NotebookView has no Notebook session reference");
	}
	const rawIndexes = model.get("_cell_indexes");
	if (rawIndexes === null) return { sessionRef, cellIndexes: null };
	if (!Array.isArray(rawIndexes)) throw new Error("NotebookView cell indexes must be an array or null");
	if (rawIndexes.length === 0) throw new Error("NotebookView cell indexes must not be empty");
	const cellIndexes: number[] = [];
	const seen = new Set<number>();
	for (const value of rawIndexes) {
		if (!Number.isInteger(value) || (value as number) < 0) {
			throw new Error("NotebookView cell indexes must be non-negative integers");
		}
		const index = value as number;
		if (seen.has(index)) throw new Error("NotebookView cell indexes must be unique");
		seen.add(index);
		cellIndexes.push(index);
	}
	cellIndexes.sort((left, right) => left - right);
	return { sessionRef, cellIndexes };
}

export function readCellKeys(model: AnyWidgetModel): string[] {
	const value = model.get("_cell_keys");
	if (!Array.isArray(value)) return [];
	return value.map((item) => (typeof item === "string" ? item : ""));
}
