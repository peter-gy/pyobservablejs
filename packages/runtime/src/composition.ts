import type { Notebook } from "@observablehq/notebook-kit";
import { notebookDefinedNamesFromAnalysis, notebookDependencyIndexes, type NotebookAnalysis } from "./graph";
import { renderCellTarget, type CellRenderContext, type CellRenderTarget } from "./cell-renderer";
import { appendCellWrapper } from "./dom";
import { type EvaluationAttempt, type EvaluationState } from "./state";
import type { NotebookRuntime } from "@observablehq/notebook-kit/runtime";
import type { NotebookOptions } from "./environment";
import type { RuntimeInputs } from "./inputs";
import type { RuntimeViewSync } from "./view-inputs";
import { createCellStateSync } from "./cell-state";
import type { NotebookValues } from "./notebook-values";
import type { AttachmentRegistry } from "./attachments";
import type { DiagnosticCollector } from "./diagnostics";

export type RenderSession = {
	root: HTMLElement;
	runtime: NotebookRuntime;
	options: NotebookOptions;
	variablesSync: RuntimeInputs;
	viewSync: RuntimeViewSync;
	signal: AbortSignal;
	values: NotebookValues;
	attachments: AttachmentRegistry;
	diagnostics: DiagnosticCollector;
};

type RenderNotebookViewOptions = {
	notebook: Notebook;
	selectedIndexes: ReadonlySet<number>;
	renderIndexes: ReadonlySet<number>;
	analysis: NotebookAnalysis;
	session: RenderSession;
	readback: EvaluationState;
	attempt: EvaluationAttempt;
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
	if (session.signal.aborted) return;
	const { options, root } = session;
	const cells = notebook.cells;
	const context: CellRenderContext = {
		runtime: session.runtime,
		signal: session.signal,
		variableNames: new Set(Object.keys(options.variables)),
		analysis,
		notebookNames: notebookDefinedNamesFromAnalysis(analysis),
		runtimeProfile: options.runtimeProfile,
		viewSync: session.viewSync,
		values: session.values,
		diagnostics: session.diagnostics,
	};
	const targets: CellRenderTarget[] = [];
	for (let index = 0; index < cells.length; index += 1) {
		if (!renderIndexes.has(index)) continue;
		const cell = cells[index];
		if (!cell) continue;
		const selected = selectedIndexes.has(index);
		const metadata = analysis.graph.cells[index];
		session.values.register(
			index,
			[...new Set([...(metadata?.defines ?? []), ...(metadata?.runtimeOutputs ?? [])])],
			metadata?.defines ?? [],
		);
		const wrapper = appendCellWrapper(root);
		if (!selected) {
			wrapper.hidden = true;
			wrapper.setAttribute("aria-hidden", "true");
		}
		targets.push({
			index,
			key: cellKeys[index] ?? "",
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
	return notebookDependencyIndexes(analysis, selectedIndexes);
}

function cellSync(index: number, readback: EvaluationState, attempt: EvaluationAttempt) {
	return createCellStateSync({
		begin: (channel, generation) => readback.beginCell(attempt, index, channel, generation),
		settle: (token, value) => readback.settleCell(token, value),
	});
}
