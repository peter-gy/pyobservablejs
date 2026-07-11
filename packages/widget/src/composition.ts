import type { Notebook } from "@observablehq/notebook-kit";
import {
	notebookDefinedNamesFromAnalysis,
	notebookDependencyIndexes,
	type NotebookAnalysis,
	type NotebookOptions,
} from "@pyobservablejs/runtime";
import { renderCellTargets, type CellRenderContext, type CellRenderTarget } from "./cell-renderer";
import { appendCellWrapper } from "./dom";
import { type ReadbackAttempt, type ViewReadback } from "./readback";
import type { NotebookRuntimeSession } from "./session";
import { createCellStateSync } from "./variable-sync";

type RenderNotebookViewOptions = {
	root: HTMLElement;
	notebook: Notebook;
	selectedIndexes: ReadonlySet<number>;
	renderIndexes: ReadonlySet<number>;
	analysis: NotebookAnalysis;
	session: NotebookRuntimeSession;
	options: NotebookOptions;
	signal: AbortSignal;
	readback: ViewReadback;
	attempt: ReadbackAttempt;
	cellKeys: readonly string[];
};

/** Render selected cells and their hidden dependency closure in one view runtime. */
export function renderNotebookView({
	root,
	notebook,
	selectedIndexes,
	renderIndexes,
	analysis,
	session,
	options,
	signal,
	readback,
	attempt,
	cellKeys,
}: RenderNotebookViewOptions): void {
	const cells = notebook.cells;
	const targets: CellRenderTarget[] = [];
	for (let index = 0; index < cells.length; index += 1) {
		if (!renderIndexes.has(index)) continue;
		const cell = cells[index];
		if (!cell) continue;
		const selected = selectedIndexes.has(index);
		const wrapper = appendCellWrapper(root);
		if (!selected) {
			wrapper.hidden = true;
			wrapper.setAttribute("aria-hidden", "true");
		}
		targets.push({
			index,
			wrapper,
			cell,
			showSource: selected && options.showSource,
			visible: selected,
			sync: selected ? cellSync(index, readback, attempt, selectedIndexes.size) : undefined,
			variablesSync: selected ? undefined : session.variablesSync,
			cellName: selected ? cellKeys[index] || undefined : undefined,
		});
	}
	renderCellTargets(targets, cellRenderContext(session, signal, options, analysis));
	session.variablesSync.applyInitialViews();
	readback.complete(attempt, selectedIndexes.size);
}

export function notebookViewIndexes(analysis: NotebookAnalysis, selectedIndexes: ReadonlySet<number>): Set<number> {
	const indexes = new Set<number>();
	for (const selected of selectedIndexes) {
		for (const index of notebookDependencyIndexes(analysis, selected)) indexes.add(index);
	}
	return indexes;
}

function cellSync(index: number, readback: ViewReadback, attempt: ReadbackAttempt, selectedCellCount: number) {
	return createCellStateSync({
		read: () => readback.read(index),
		publish(value) {
			readback.publish(attempt, index, value);
			readback.complete(attempt, selectedCellCount);
		},
	});
}

function cellRenderContext(
	session: NotebookRuntimeSession,
	signal: AbortSignal,
	options: NotebookOptions,
	analysis: NotebookAnalysis,
): CellRenderContext {
	return {
		runtime: session.runtime,
		signal,
		pythonVariableNames: new Set(Object.keys(options.variables)),
		analysis,
		notebookNames: notebookDefinedNamesFromAnalysis(analysis),
		runtimeCompatibility: options.runtimeCompatibility,
		viewSync: session.viewSync,
	};
}
