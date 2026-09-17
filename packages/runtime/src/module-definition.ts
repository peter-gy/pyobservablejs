import type { ModuleDefinition, VariableDefinition, RuntimeValue } from "@observablehq/runtime";
import { analyzeNotebook, notebookDefinedNamesFromAnalysis } from "./graph";
import { createRuntimeDefinition } from "./definition";
import { createRuntimeBuiltins } from "./environment";
import { registerAttachments } from "./attachments";
import { isCallable } from "./value-kind";
import type { ImportModule } from "./import-code";
import type { NormalizedNotebook, NotebookSource } from "./source";
import { defineModuleCell, nextModuleCellId } from "./module-cell";

export type LoadedNotebook = NormalizedNotebook & Pick<NotebookSource, "attachments" | "baseUrl">;

export function createNotebookModule(
	root: HTMLElement,
	record: LoadedNotebook,
	importModule: ImportModule,
	signal: AbortSignal,
	cleanups: (() => void)[],
): ModuleDefinition {
	const { notebook, origin, runtimeProfile, attachments: attachmentInfo = {}, baseUrl } = record;
	const analysis = analyzeNotebook(notebook, [], runtimeProfile);
	const failure = analysis.cells.find((cell) => cell.definition === null);
	if (failure)
		throw Object.assign(
			new Error(
				`Unable to compile imported notebook ${origin?.id ?? "notebook"}, cell ${failure.cell.id}: ${String(failure.error)}`,
			),
			{ cause: failure.error },
		);
	const names = notebookDefinedNamesFromAnalysis(analysis);
	return (native) => {
		signal.throwIfAborted();
		const main = native.module();
		const attachments = registerAttachments(attachmentInfo);
		cleanups.push(() => attachments.cleanup());
		const { builtins, scope } = createRuntimeBuiltins(
			root,
			{
				attachments: attachmentInfo,
				variables: {},
				baseUrl: baseUrl ?? root.ownerDocument.baseURI,
				runtimeProfile,
			},
			attachments,
		);
		cleanups.push(() => scope.cleanup());
		builtins.display = () => (value: RuntimeValue) => value;
		builtins.view = () => (value: { value: RuntimeValue }) => value.value;
		const referenced = new Set(analysis.graph.cells.flatMap((cell) => cell.references));
		for (const name of referenced) {
			if (names.has(name) || !Object.prototype.hasOwnProperty.call(builtins, name)) continue;
			const value = builtins[name];
			// SAFETY: Runtime libraries contain callable variable definitions or constant values.
			const definition = isCallable(value) ? (value as VariableDefinition) : () => value;
			main.define(name, [], definition);
		}
		const defineCell = (cell: (typeof analysis.cells)[number]) => {
			if (!cell.definition) return;
			for (const imported of cell.definition.imports ?? [])
				defineCell({ ...cell, cell: { ...cell.cell, id: nextModuleCellId(main) }, definition: imported });
			const outputRoot = root.ownerDocument.createElement("div");
			const definition = createRuntimeDefinition(cell.cell, cell.definition, {
				document: scope.document,
				root: outputRoot,
				runtimeProfile,
				notebookNames: names,
				importModule,
			});
			defineModuleCell(main, definition);
		};
		for (const cell of analysis.cells) defineCell(cell);
		return main;
	};
}
