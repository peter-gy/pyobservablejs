import type { NotebookState, CellGraph, GraphEdge } from "@pyobservablejs/runtime";
import {
	createDiagnostic,
	errorDetails,
	type Diagnostic,
	type DiagnosticCell,
	type DiagnosticOrigin,
	type ErrorDetail,
} from "@pyobservablejs/runtime/diagnostics";
import { toWireValue, type WireBudget, type WireValues } from "./values";

export type WireGraph = {
	cells: Array<Omit<CellGraph, "runtimeOutputs"> & { runtime_outputs: readonly string[] }>;
	edges: readonly GraphEdge[];
};
export type WireCell = {
	revision: number;
	status: "pending" | "success" | "error";
	values: WireValues;
	errors: Array<ErrorDetail & { phase: "analysis" | "evaluation" | "rendering" | "serialization"; variable?: string }>;
};
export type WireReadback = {
	revision: number;
	input_revision: number | null;
	settled_revision: number | null;
	pending: boolean;
	graph: WireGraph | Record<string, never>;
	results: Record<string, WireCell>;
	errors: Array<ErrorDetail & { phase: WireCell["errors"][number]["phase"] }>;
};

export function toWireGraph(graph: NotebookState["graph"]): WireReadback["graph"] {
	return graph
		? {
				cells: graph.cells.map(({ runtimeOutputs, ...cell }) => ({ ...cell, runtime_outputs: runtimeOutputs })),
				edges: graph.edges,
			}
		: {};
}

export function encodeCellResult(
	result: NotebookState["results"][number],
	budget: WireBudget,
	context: { offset: number; cell?: DiagnosticCell; origin: DiagnosticOrigin },
) {
	const values: WireValues = {};
	const errors: WireCell["errors"] = [...result.errors];
	const diagnostics: Diagnostic[] = [];
	for (const [name, value] of Object.entries(result.values)) {
		try {
			Object.defineProperty(values, name, {
				value: toWireValue(value, budget),
				enumerable: true,
				configurable: true,
				writable: true,
			});
		} catch (cause) {
			const diagnostic = createDiagnostic(cause, {
				origin: context.origin,
				phase: "serialization",
				component: "packages/protocol/src/values.ts",
				operation: "serialize cell value",
				variable: name,
				cell: context.cell,
			});
			diagnostics.push(diagnostic);
			errors.push({ ...errorDetails(cause), phase: "serialization", variable: name });
		}
	}
	const value: WireCell = {
		revision: result.revision + context.offset,
		status: errors.length ? "error" : result.status,
		values,
		errors,
	};
	return { value, diagnostics };
}
