import type { NotebookRuntime } from "@observablehq/notebook-kit/runtime";
import { observeRuntimeVariable } from "./execution";
import type { CellVariableSync } from "./cell-state";
import type { NotebookValues } from "./notebook-values";
import type { RuntimeValue } from "./values";
import {
	createDiagnostic,
	DiagnosticError,
	errorDetails,
	type DiagnosticCell,
	type DiagnosticCollector,
	type DiagnosticContext,
} from "./diagnostics";

type CellEvaluationOptions = {
	cell: DiagnosticCell;
	signal: AbortSignal;
	values: NotebookValues;
	diagnostics: DiagnosticCollector;
	sync?: CellVariableSync;
};

/** Own native value observation and error attribution independently of display observers. */
export function createCellEvaluation({ cell, signal, values, diagnostics, sync }: CellEvaluationOptions) {
	const report = <Cause>(cause: Cause, context: Omit<DiagnosticContext, "cell">, channel: string) => {
		const diagnostic = createDiagnostic(cause, { ...context, cell });
		if (!signal.aborted) diagnostics.report(diagnostic, channel);
		return diagnostic;
	};
	return {
		report,
		analysisFailure<Cause>(cause: Cause) {
			const diagnostic = report(
				cause,
				{
					origin: errorDetails(cause).name === "SyntaxError" ? "notebook" : "runtime",
					phase: "analysis",
					component: "packages/runtime/src/graph.ts",
					operation: "analyze cell",
				},
				"analysis",
			);
			values.fail(cell.index, cause, diagnostic);
			sync?.fail(new DiagnosticError(diagnostic), "analysis");
		},
		observeVariables(runtime: NotebookRuntime, names: readonly string[], runtimeNames: readonly string[]) {
			for (const name of new Set([...names, ...runtimeNames])) {
				const capture = names.includes(name) ? sync : undefined;
				const channel = `variable:${name}`;
				observeRuntimeVariable(runtime, name, {
					pending() {
						if (signal.aborted) return;
						values.pending(cell.index, name);
						capture?.pending(channel);
					},
					fulfilled(value) {
						if (signal.aborted) return;
						try {
							// SAFETY: RuntimeValue includes every native Observable value.
							const native = value as RuntimeValue;
							values.fulfilled(cell.index, name, native);
							capture?.fulfilled(channel, name, native);
						} catch (cause) {
							const diagnostic = report(
								cause,
								{
									origin: "runtime",
									phase: "evaluation",
									component: "packages/runtime/src/cell-evaluation.ts",
									operation: "publish cell value",
									variable: name,
								},
								channel,
							);
							values.rejected(cell.index, name, cause, diagnostic);
							capture?.fail(new DiagnosticError(diagnostic), "evaluation", name);
						}
					},
					rejected(cause) {
						if (signal.aborted) return;
						const diagnostic =
							diagnostics.getCell(cell.index, "evaluation") ??
							report(
								cause,
								{
									origin: "notebook",
									phase: "evaluation",
									component: "packages/runtime/src/cell-evaluation.ts",
									operation: "evaluate variable",
									variable: name,
								},
								channel,
							);
						values.rejected(cell.index, name, cause, diagnostic);
						capture?.rejected(channel, new DiagnosticError(diagnostic), "evaluation", name);
					},
				});
			}
		},
	};
}

export type CellEvaluation = ReturnType<typeof createCellEvaluation>;
