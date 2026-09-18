import { createCellEvaluation } from "./cell-evaluation";
import type { NotebookSpec } from "@observablehq/notebook-kit";
import { normalizeNotebook, type NotebookOrigin, type ResolveNotebook, type RuntimeProfile } from "./source";
import {
	analyzeNotebook,
	notebookAffectedIndexes,
	notebookDefinedNamesFromAnalysis,
	notebookDependencyIndexes,
} from "./graph";
import { inspectAnalysis, type NotebookInspection } from "./inspection";
import type { AttachmentInfo } from "./attachment-info";
import { createRuntimeSession, type RuntimeSession } from "./session";
import { assertNoRuntimeBuiltinCollisions, setRuntimeVariables } from "./environment";
import { defineRuntimeCell } from "./execution";
import { exposedVariableNames, runtimeOutputNames } from "./definition";
import { hostOwnedNames, sourceRuntimeDefinition } from "./ownership";
import { runtimeDocument } from "./scope";
import { selectedIndexes } from "./selection";
import { EvaluationState, type NotebookState } from "./state";
import { createCellStateSync } from "./cell-state";
import { NotebookValues, type DatasetInfo } from "./notebook-values";
import { readNotebook, type ReadSelector, type ReadOptions, type NotebookRead } from "./read";
import { DiagnosticCollector, DiagnosticError, type Diagnostic } from "./diagnostics";
import { readyState } from "./ready";
import type { RuntimeValue, Variables } from "./values";

export type EvaluateOptions = {
	variables?: Variables;
	selection?: readonly number[];
	keys?: readonly string[];
	attachments?: Record<string, AttachmentInfo>;
	baseUrl?: string;
	runtimeProfile?: RuntimeProfile;
	origin?: NotebookOrigin;
	resolveNotebook?: ResolveNotebook;
	document?: Document;
	signal?: AbortSignal;
};

export type EvaluatedNotebook = {
	readonly state: NotebookState;
	readonly inspection: NotebookInspection;
	readonly datasets: readonly DatasetInfo[];
	readonly diagnostics: readonly Diagnostic[];
	discover(options?: {
		signal?: AbortSignal;
	}): Promise<{ datasets: readonly DatasetInfo[]; errors: readonly Diagnostic[]; pending: boolean }>;
	ready(options?: { signal?: AbortSignal }): Promise<NotebookState>;
	read(selector: ReadSelector, options?: ReadOptions): Promise<NotebookRead>;
	updateVariables(patch: Variables): void;
	replaceVariables(variables: Variables): void;
	dispose(): void;
};

/** Evaluate with native Notebook Kit definitions and observers, without mounting a view. */
export function evaluateNotebook(source: string | NotebookSpec, options: EvaluateOptions = {}): EvaluatedNotebook {
	options.signal?.throwIfAborted();
	const lifetime = new AbortController();
	const signal = options.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal;
	const normalized = normalizeNotebook(source, options);
	const { notebook, runtimeProfile, origin } = normalized;
	const keys = options.keys ?? [];
	const analysis = analyzeNotebook(notebook, keys, runtimeProfile);
	const inspection = inspectAnalysis(notebook, analysis, { ...options, runtimeProfile, origin });
	const selected = selectedIndexes(options.selection, notebook.cells.length);
	const indexes = notebookDependencyIndexes(analysis, selected);
	const names = notebookDefinedNamesFromAnalysis(analysis);
	const state = new EvaluationState(true, signal);
	const diagnostics = new DiagnosticCollector();
	const values = new NotebookValues();
	const root = (options.document ?? document).createElement("div");
	const baseUrl = options.baseUrl || "https://observablehq.com/";
	let variables = { ...options.variables };
	let session: RuntimeSession | undefined;
	let generation = new AbortController();
	let attempt = 0;
	let disposed = false;
	const variableNamesOwned = (name: string) => Object.prototype.hasOwnProperty.call(variables, name);

	const requireSession = () => {
		if (disposed || !session) throw new Error("Notebook evaluation is closed");
		return session;
	};
	const start = () => {
		generation.abort();
		session?.dispose();
		session = undefined;
		generation = new AbortController();
		const active = AbortSignal.any([signal, generation.signal]);
		values.reset();
		diagnostics.clear();
		attempt = state.start();
		state.syncGraph(attempt, analysis, indexes, keys);
		session = createRuntimeSession(root, {
			variables,
			attachments: options.attachments ?? {},
			baseUrl,
			runtimeProfile,
			origin,
			resolveNotebook: options.resolveNotebook,
			headless: true,
		});
		const runtime = session.runtime;
		const variableNames = new Set(Object.keys(variables));
		state.begin(attempt, selected);
		for (const entry of analysis.cells) {
			const { index, cell, graph } = entry;
			if (!indexes.has(index)) continue;
			const capture = selected.has(index);
			const currentAttempt = attempt;
			const sync = createCellStateSync({
				begin: (channel, revision) => state.beginCell(currentAttempt, index, channel, revision),
				settle: (token, result) => state.settleCell(token, result),
			});
			const evaluation = createCellEvaluation({
				cell: { index, id: cell.id, key: keys[index] ?? "", mode: cell.mode, source: cell.value },
				signal: active,
				values,
				diagnostics,
				sync: capture ? sync : undefined,
			});
			const report = <Cause>(cause: Cause, origin: "notebook" | "runtime" = "notebook") =>
				evaluation.report(
					cause,
					{
						origin,
						phase: "evaluation",
						component: "packages/runtime/src/evaluate.ts",
						operation: origin === "runtime" ? "define cell" : "evaluate cell",
					},
					"evaluation",
				);
			if (!entry.definition) {
				values.register(index, [...new Set([...graph.defines, ...graph.runtimeOutputs])], graph.defines);
				evaluation.analysisFailure(entry.error);
				continue;
			}
			const definition = entry.definition;
			const exposed = exposedVariableNames(definition);
			const owned = definition.autoview
				? exposed.filter((name) => variableNames.has(name))
				: hostOwnedNames(definition, exposed, variableNames);
			const allOwned = owned.length > 0 && owned.length === exposed.length;
			const runtimeNames = allOwned && definition.autoview ? [] : runtimeOutputNames(definition);
			values.register(index, [...new Set([...exposed, ...runtimeNames])], exposed);
			const anonymous = exposed.length === 0;
			if (capture) sync.configure(exposed, !allOwned);
			const displayObserver = {
				pending() {
					if (active.aborted) return;
					diagnostics.clearCell(index);
					if (anonymous) values.pending(index, null);
					if (capture) sync.pending("display");
				},
				fulfilled(value: RuntimeValue) {
					if (active.aborted) return;
					if (anonymous) values.fulfilled(index, null, value);
					if (capture) sync.fulfilled("display", anonymous ? keys[index] || undefined : undefined, value);
				},
				rejected<Cause>(cause: Cause) {
					if (active.aborted) return;
					const diagnostic = report(cause);
					if (anonymous) values.rejected(index, null, cause, diagnostic);
					if (capture) sync.rejected("display", new DiagnosticError(diagnostic), "evaluation");
				},
			};
			try {
				if (!allOwned) {
					defineRuntimeCell(
						runtime,
						root.ownerDocument.createElement("div"),
						cell,
						{ ...sourceRuntimeDefinition(definition, owned), display: false },
						(display) => ({ ...displayObserver, _error: false, _node: display.root }),
						{ document: runtimeDocument(runtime), notebookNames: names, runtimeProfile },
					);
				}
				evaluation.observeVariables(runtime, exposed, runtimeNames);
			} catch (cause) {
				const diagnostic = report(cause, "runtime");
				values.fail(index, cause, diagnostic);
				if (capture) sync.fail(new DiagnosticError(diagnostic), "evaluation");
			}
		}
		// Host values take precedence over viewof and mutable derived variables too.
		setRuntimeVariables(runtime, variables);
	};
	const dispose = () => {
		if (disposed) return;
		disposed = true;
		generation.abort();
		lifetime.abort();
		session?.dispose();
		session = undefined;
		state.close();
		values.reset();
		diagnostics.close();
	};
	signal.addEventListener("abort", dispose, { once: true });
	const restart = () => {
		try {
			start();
		} catch (cause) {
			dispose();
			throw cause;
		}
	};
	restart();
	return {
		get state() {
			return state.state;
		},
		get inspection() {
			return inspection;
		},
		get datasets() {
			return values.datasets();
		},
		get diagnostics() {
			return diagnostics.errors;
		},
		async ready(readyOptions = {}) {
			requireSession();
			return readyState(
				state,
				diagnostics,
				readyOptions.signal ? AbortSignal.any([signal, readyOptions.signal]) : signal,
			);
		},
		async discover(discoveryOptions = {}) {
			requireSession();
			const active = discoveryOptions.signal ? AbortSignal.any([signal, discoveryOptions.signal]) : signal;
			await values.settle(active);
			return { datasets: values.datasets(), errors: diagnostics.errors, pending: values.isPending };
		},
		async read(selector, readOptions = {}) {
			const core = requireSession();
			return readNotebook(selector, readOptions, {
				values,
				inspection,
				attachments: core.attachments,
				baseUrl,
				signal: AbortSignal.any([signal, generation.signal]),
			});
		},
		updateVariables(patch) {
			const { runtime } = requireSession();
			assertNoRuntimeBuiltinCollisions(runtime, patch);
			if (!Object.keys(patch).length) return;
			const newView = Object.keys(patch).some((name) => analysis.viewNames.has(name) && !variableNamesOwned(name));
			if (newView) {
				variables = { ...variables, ...patch };
				state.invalidate(true);
				restart();
				return;
			}
			const affected = notebookAffectedIndexes(analysis, new Set(Object.keys(patch)));
			for (const index of affected) diagnostics.clearCell(index);
			values.invalidate(affected);
			state.beginInput(attempt, affected);
			variables = { ...variables, ...patch };
			setRuntimeVariables(runtime, patch);
		},
		replaceVariables(next) {
			assertNoRuntimeBuiltinCollisions(requireSession().runtime, next);
			variables = { ...next };
			state.invalidate(true);
			restart();
		},
		dispose,
	};
}
