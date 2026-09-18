export function selectedIndexes(selection: readonly number[] | undefined, count: number): Set<number> {
	if (selection === undefined) return new Set(Array.from({ length: count }, (_, index) => index));
	const indexes = new Set<number>();
	for (const index of selection) {
		if (!Number.isSafeInteger(index) || index < 0 || index >= count)
			throw new Error(`Notebook cell index ${index} is outside the notebook`);
		if (indexes.has(index)) throw new Error("Notebook cell indexes must be unique");
		indexes.add(index);
	}
	return indexes;
}
