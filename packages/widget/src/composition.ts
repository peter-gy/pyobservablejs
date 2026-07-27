import type { Notebook } from "@observablehq/notebook-kit";
import {
	notebookDefinedNamesFromAnalysis,
	notebookDependencyIndexes,
	type NotebookAnalysis,
} from "@pyobservablejs/runtime";
import { renderCellTarget, type CellRenderContext, type CellRenderTarget } from "./cell-renderer";
import { appendCellWrapper } from "./dom";
import { type ReadbackAttempt, type ViewReadback } from "./readback";
import type { NotebookRuntimeSession } from "./session";
import { createCellStateSync } from "./variable-sync";

type RenderNotebookViewOptions = {
	notebook: Notebook;
	selectedIndexes: ReadonlySet<number>;
	renderIndexes: ReadonlySet<number>;
	analysis: NotebookAnalysis;
	session: NotebookRuntimeSession;
	readback: ViewReadback;
	attempt: ReadbackAttempt;
	cellKeys: readonly string[];
};

/** Render selected cells and their hidden dependency closure in one view runtime. */
export function renderNotebookView({
	notebook,
	selectedIndexes,
	renderIndexes,
	analysis,
	session,
	readback,
	attempt,
	cellKeys,
}: RenderNotebookViewOptions): void {
	readback.begin(attempt, selectedIndexes);
	const { options, root } = session;
	const cells = notebook.cells;
	const context: CellRenderContext = {
		runtime: session.runtime,
		signal: session.signal,
		pythonVariableNames: new Set(Object.keys(options.variables)),
		analysis,
		notebookNames: notebookDefinedNamesFromAnalysis(analysis),
		runtimeProfile: options.runtimeProfile,
		viewSync: session.viewSync,
	};
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
			sync: selected && readback.captureState ? cellSync(index, readback, attempt) : undefined,
			cellName: selected ? cellKeys[index] || undefined : undefined,
		});
	}
	for (const target of targets) renderCellTarget(target, context);
	session.variablesSync.applyInitialViews();
}

export function notebookViewIndexes(analysis: NotebookAnalysis, selectedIndexes: ReadonlySet<number>): Set<number> {
	const indexes = new Set<number>();
	for (const selected of selectedIndexes) {
		for (const index of notebookDependencyIndexes(analysis, selected)) indexes.add(index);
	}
	return indexes;
}

function cellSync(index: number, readback: ViewReadback, attempt: ReadbackAttempt) {
	return createCellStateSync({
		begin: (channel, generation) => readback.beginCell(attempt, index, channel, generation),
		settle: (token, value) => readback.settleCell(token, value),
	});
}
