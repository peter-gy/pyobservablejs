import type { RenderProps } from "@anywidget/types";
import type { Cell, Notebook } from "@observablehq/notebook-kit";
import type { NotebookRuntime } from "@observablehq/notebook-kit/runtime";
import {
	notebookDefinedNamesFromAnalysis,
	notebookDependencyIndexes,
	type NotebookAnalysis,
	type NotebookOptions,
	type RuntimeVariablesSync,
} from "@pyobservablejs/runtime";
import { renderCellTarget, renderCellTargets, type CellRenderContext, type CellRenderTarget } from "./cell-renderer";
import { readCellKeys } from "./composition-state";
import { appendCellWrapper } from "./dom";
import type { WidgetModel } from "./model";
import { type NotebookReadback, type ReadbackAttempt, syncNotebookGraph } from "./readback";
import { createCellStateSync } from "./variable-sync";

type RenderNotebookCellsOptions = {
	model: RenderProps<WidgetModel>["model"];
	root: HTMLElement;
	notebook: Notebook;
	analysis: NotebookAnalysis;
	runtime: NotebookRuntime;
	options: NotebookOptions;
	variablesSync: RuntimeVariablesSync;
	signal: AbortSignal;
	readback: NotebookReadback;
	attempt: ReadbackAttempt;
};

type RenderCellProjectionOptions = RenderNotebookCellsOptions & {
	cellModel: RenderProps<WidgetModel>["model"];
	cellIndex: number;
};

/** Render every logical cell through one Notebook-owned runtime. */
export function renderNotebookCells({
	model,
	root,
	notebook,
	analysis,
	runtime,
	options,
	variablesSync,
	signal,
	readback,
	attempt,
}: RenderNotebookCellsOptions): void {
	const cells = notebook.cells;
	const keys = readCellKeys(model);
	const context = cellRenderContext(runtime, signal, options, analysis);
	for (let index = 0; index < cells.length; index += 1) {
		const cell = cells[index];
		if (!cell) continue;
		const sync = cellSync({
			model,
			index,
			signal,
			variablesSync,
			readback,
			attempt,
			onPublish: () => readback.completeFullView(attempt, cells.length),
		});
		renderCellTarget(
			{
				index,
				wrapper: appendCellWrapper(root),
				cell,
				showSource: options.showSource,
				visible: true,
				sync,
				cellName: keys[index] || undefined,
			},
			context,
		);
	}
	variablesSync.applyInitialViews();
	readback.completeFullView(attempt, cells.length);
}

/** Render one cell plus the hidden dependency closure in a parent view. */
export function renderCellProjection({
	model,
	cellModel,
	root,
	notebook,
	cellIndex,
	analysis,
	runtime,
	options,
	variablesSync,
	signal,
	readback,
	attempt,
}: RenderCellProjectionOptions): void {
	const cells = notebook.cells;
	if (!Number.isInteger(cellIndex) || cellIndex < 0 || cellIndex >= cells.length) {
		throw new Error(`NotebookCell index ${cellIndex} is outside the parent Notebook`);
	}
	syncNotebookGraph(model, notebook, readCellKeys(model), analysis);
	const targets = projectionTargets({
		model,
		cellModel,
		root,
		cells,
		cellIndex,
		options,
		variablesSync,
		signal,
		analysis,
		readback,
		attempt,
	});
	renderCellTargets(targets, cellRenderContext(runtime, signal, options, analysis));
	variablesSync.applyInitialViews();
}

function projectionTargets({
	model,
	cellModel,
	root,
	cells,
	cellIndex,
	options,
	variablesSync,
	signal,
	analysis,
	readback,
	attempt,
}: {
	model: RenderProps<WidgetModel>["model"];
	cellModel: RenderProps<WidgetModel>["model"];
	root: HTMLElement;
	cells: readonly Cell[];
	cellIndex: number;
	options: NotebookOptions;
	variablesSync: RuntimeVariablesSync;
	signal: AbortSignal;
	analysis: NotebookAnalysis;
	readback: NotebookReadback;
	attempt: ReadbackAttempt;
}): CellRenderTarget[] {
	const renderIndexes = notebookDependencyIndexes(analysis, cellIndex);
	const targets: CellRenderTarget[] = [];
	for (let index = 0; index < cells.length; index += 1) {
		if (!renderIndexes.has(index)) continue;
		const cell = cells[index];
		if (!cell) continue;
		const selected = index === cellIndex;
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
			sync: selected ? cellSync({ model, index, signal, variablesSync, readback, attempt }) : undefined,
			variablesSync: selected ? undefined : variablesSync,
			cellName: selected ? cellModel.get("key") || cellModel.get("name") : undefined,
		});
	}
	return targets;
}

function cellSync({
	model,
	index,
	signal,
	variablesSync,
	readback,
	attempt,
	onPublish,
}: {
	model: RenderProps<WidgetModel>["model"];
	index: number;
	signal: AbortSignal;
	variablesSync: RuntimeVariablesSync;
	readback: NotebookReadback;
	attempt: ReadbackAttempt;
	onPublish?: () => void;
}) {
	return createCellStateSync({
		model,
		signal,
		variablesSync,
		read: () => readback.read(index),
		publish(value) {
			readback.publish(attempt, index, value);
			onPublish?.();
		},
	});
}

function cellRenderContext(
	runtime: NotebookRuntime,
	signal: AbortSignal,
	options: NotebookOptions,
	analysis: NotebookAnalysis,
): CellRenderContext {
	return {
		runtime,
		signal,
		pythonVariableNames: new Set(Object.keys(options.variables)),
		analysis,
		notebookNames: notebookDefinedNamesFromAnalysis(analysis),
		runtimeCompatibility: options.runtimeCompatibility,
	};
}
