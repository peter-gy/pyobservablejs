import { deserialize, toNotebook, type Notebook, type NotebookSpec } from "@observablehq/notebook-kit";
import type { AttachmentInfo } from "./attachment-info";
import { notebookViewIndexes, renderNotebookView, type RenderSession } from "./composition";
import { CLASS_NAMES, createNotebookRoot, createTopLevelError, prepareNotebookShell } from "./dom";
import { assertNoRuntimeBuiltinCollisions, type NotebookOptions, type RuntimeProfile } from "./environment";
import {
	analyzeNotebook,
	notebookAffectedIndexes,
	notebookViewNamesFromAnalysis,
	type NotebookAnalysis,
} from "./graph";
import { createRuntimeInputs } from "./inputs";
import { createRuntimeSession } from "./session";
import { EvaluationState, type NotebookState } from "./state";
import { installNotebookThemeStyles } from "./themes";
import { createRuntimeViewSync, writeProgrammaticViewValue } from "./view-inputs";
import { isString } from "./value-kind";
import type { RuntimeValue, Variables } from "./values";
import { inspectAnalysis, type NotebookInspection } from "./inspection";
import { NotebookValues, type DatasetInfo } from "./notebook-values";
import { readNotebook, type ReadSelector, type ReadOptions, type NotebookRead } from "./read";
import {
	createDiagnostic,
	DiagnosticCollector,
	DiagnosticError,
	type Diagnostic,
	type DiagnosticContext,
} from "./diagnostics";

export type MountOptions = {
	variables?: Variables;
	inputs?: Variables;
	selection?: readonly number[];
	keys?: readonly string[];
	attachments?: Record<string, AttachmentInfo>;
	baseUrl?: string;
	runtimeProfile?: RuntimeProfile;
	theme?: Notebook["theme"];
	showSource?: boolean;
	captureState?: boolean;
	signal?: AbortSignal;
	onState?(state: NotebookState): void;
	onInput?(name: string, value: RuntimeValue): void;
	onDatasets?(datasets: readonly DatasetInfo[]): void;
	onDiagnostics?(errors: readonly Diagnostic[]): void;
};

export type MountedNotebook = {
	readonly state: NotebookState;
	readonly inspection: NotebookInspection | null;
	readonly datasets: readonly DatasetInfo[];
	readonly diagnostics: readonly Diagnostic[];
	ready(options?: { signal?: AbortSignal }): Promise<NotebookState>;
	read(selector: ReadSelector, options?: ReadOptions): Promise<NotebookRead>;
	updateVariables(patch: Variables): void;
	replaceVariables(variables: Variables): void;
	setInputs(inputs: Variables): void;
	dispose(): void;
};

type PreparedNotebook = {
	notebook: Notebook;
	analysis: NotebookAnalysis;
	selected: ReadonlySet<number>;
	indexes: ReadonlySet<number>;
	inspection: NotebookInspection;
};

const mountedElements = new WeakSet<HTMLElement>();

export function mountNotebook(
	el: HTMLElement,
	source: string | NotebookSpec,
	options: MountOptions = {},
): MountedNotebook {
	options.signal?.throwIfAborted();
	if (mountedElements.has(el)) throw new Error("Notebook element already has a live mount");
	mountedElements.add(el);
	const ownsHostClass = !el.classList.contains(CLASS_NAMES.host);
	const lifetime = new AbortController();
	const signal = options.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal;
	const diagnostics = new DiagnosticCollector(options.onDiagnostics);
	const callbackError = <Cause>(cause: Cause, operation: string) =>
		diagnostics.report(
			createDiagnostic(cause, {
				origin: "runtime",
				phase: "rendering",
				component: "packages/runtime/src/mount.ts",
				operation,
			}),
		);
	const state = new EvaluationState(
		options.captureState ?? true,
		signal,
		options.onState
			? (snapshot) => {
					try {
						options.onState?.(snapshot);
					} catch (cause) {
						callbackError(cause, "onState");
					}
				}
			: undefined,
	);
	const notifyDatasets = options.onDatasets;
	const values = new NotebookValues(
		notifyDatasets
			? (datasets) => {
					if (!signal.aborted) {
						try {
							notifyDatasets(datasets);
						} catch (cause) {
							callbackError(cause, "onDatasets");
						}
					}
				}
			: undefined,
	);
	const keys = [...(options.keys ?? [])];
	let prepared: PreparedNotebook | undefined;
	let variables = { ...options.variables };
	let inputs = { ...options.inputs };
	let current: AbortController | undefined;
	let session: RenderSession | undefined;
	let disposed = false;
	let beginCurrentInput: (names: ReadonlySet<string>) => void = () => {};

	const dispose = () => {
		if (disposed) return;
		disposed = true;
		current?.abort();
		state.close();
		values.reset();
		lifetime.abort();
		diagnostics.close();
		el.replaceChildren();
		if (ownsHostClass) el.classList.remove(CLASS_NAMES.host);
		mountedElements.delete(el);
	};
	signal.addEventListener("abort", dispose, { once: true });

	const render = () => {
		if (disposed) return;
		diagnostics.clear();
		current?.abort();
		values.reset();
		current = new AbortController();
		const attemptSignal = AbortSignal.any([signal, current.signal]);
		const attempt = state.start();
		session = undefined;
		try {
			if (!prepared) {
				const parsed = isString(source) ? deserialize(source) : toNotebook(source);
				const notebook = options.theme === undefined ? parsed : { ...parsed, theme: options.theme };
				const selected = selectedIndexes(options.selection, notebook.cells.length);
				const analysis = analyzeNotebook(notebook, [], options.runtimeProfile);
				prepared = {
					notebook,
					analysis,
					selected,
					indexes: notebookViewIndexes(analysis, selected),
					inspection: inspectAnalysis(notebook, analysis, { ...options, keys }),
				};
			}
			const { notebook, analysis, selected, indexes } = prepared;
			state.syncGraph(attempt, analysis, indexes, keys);
			prepareNotebookShell(el);
			const ownerRoot = el.getRootNode();
			installNotebookThemeStyles(ownerRoot instanceof ShadowRoot ? ownerRoot : el.ownerDocument);
			const root = createNotebookRoot(el, notebook.theme);
			const runtimeOptions: NotebookOptions = {
				variables,
				attachments: options.attachments ?? {},
				baseUrl: options.baseUrl ?? el.ownerDocument.baseURI,
				runtimeProfile: options.runtimeProfile,
				showSource: options.showSource ?? false,
			};
			const core = createRuntimeSession(root, runtimeOptions);
			attemptSignal.addEventListener(
				"abort",
				() => {
					try {
						core.dispose();
					} catch (cause) {
						callbackError(cause, "dispose runtime");
					}
				},
				{ once: true },
			);
			const beginInput = (names: ReadonlySet<string>) => {
				const affected = notebookAffectedIndexes(analysis, names);
				for (const index of affected) diagnostics.clearCell(index);
				values.invalidate(affected);
				state.beginInput(attempt, affected);
			};
			beginCurrentInput = beginInput;
			const inputError = <Cause>(name: string, cause: Cause, component: string, operation: string) => {
				const target = analysis.cells.find((entry) => entry.viewName === name || entry.graph.defines.includes(name));
				const context: DiagnosticContext = {
					origin: "runtime",
					phase: "evaluation",
					component,
					operation,
					variable: name,
				};
				const diagnostic = createDiagnostic(
					cause,
					target
						? {
								...context,
								cell: {
									index: target.index,
									id: target.cell.id,
									key: keys[target.index] ?? "",
									mode: target.cell.mode,
									source: target.cell.value,
								},
							}
						: context,
				);
				diagnostics.report(diagnostic);
				if (attemptSignal.aborted) return;
				for (const index of notebookAffectedIndexes(analysis, new Set([name]))) values.fail(index, cause, diagnostic);
				state.fail(attempt, new DiagnosticError(diagnostic), "evaluation");
			};
			const variablesSync = createRuntimeInputs({
				runtime: core.runtime,
				variables,
				viewNames: notebookViewNamesFromAnalysis(analysis),
				signal: attemptSignal,
				onVariablesChange(next) {
					variables = next;
					runtimeOptions.variables = next;
				},
				onReplace() {
					diagnostics.clear();
					state.invalidate(true);
					render();
				},
				onError: (name, cause) => inputError(name, cause, "packages/runtime/src/inputs.ts", "write input"),
				writeViewValue: writeProgrammaticViewValue,
			});
			const viewSync = createRuntimeViewSync({
				variables: variablesSync,
				initialValues: inputs,
				signal: attemptSignal,
				onChange: beginInput,
				onError: (name, cause, operation) => inputError(name, cause, "packages/runtime/src/view-inputs.ts", operation),
				onInput(name, value) {
					inputs = { ...inputs, [name]: value };
					try {
						options.onInput?.(name, value);
					} catch (cause) {
						callbackError(cause, "onInput");
					}
				},
			});
			session = {
				root,
				runtime: core.runtime,
				options: runtimeOptions,
				variablesSync,
				viewSync,
				signal: attemptSignal,
				values,
				attachments: core.attachments,
				diagnostics,
			};
			renderNotebookView({
				notebook,
				selectedIndexes: selected,
				renderIndexes: indexes,
				analysis,
				session,
				readback: state,
				attempt,
				cellKeys: keys,
			});
		} catch (error) {
			diagnostics.report(
				createDiagnostic(error, {
					origin: "runtime",
					phase: "rendering",
					component: "packages/runtime/src/mount.ts",
					operation: "mount notebook",
				}),
			);
			el.replaceChildren(createTopLevelError(error, el.ownerDocument));
			state.fail(attempt, error, "rendering");
			current.abort();
		}
	};
	const clearInputs = (names: ReadonlySet<string>) => {
		for (const name of names) delete inputs[name];
		session?.viewSync.clear(names);
	};
	const requireSession = () => {
		if (disposed) throw new Error("Notebook mount is disposed");
		if (!session || session.signal.aborted) throw new Error("Notebook mount has no active runtime");
		return session;
	};
	render();
	return {
		get state() {
			return state.state;
		},
		get inspection() {
			return disposed ? null : (prepared?.inspection ?? null);
		},
		get datasets() {
			return values.datasets();
		},
		get diagnostics() {
			return diagnostics.errors;
		},
		async ready(readyOptions = {}) {
			if (disposed) throw new Error("Notebook mount is disposed");
			if (!state.captureState) throw new TypeError("Notebook ready requires captureState: true");
			const readySignal = readyOptions.signal ? AbortSignal.any([signal, readyOptions.signal]) : signal;
			return new Promise((resolve, reject) => {
				let unsubscribeState = () => {};
				let unsubscribeDiagnostics = () => {};
				const cleanup = () => {
					unsubscribeState();
					unsubscribeDiagnostics();
					readySignal.removeEventListener("abort", abort);
				};
				const abort = () => {
					cleanup();
					reject(new DOMException("Notebook ready cancelled", "AbortError"));
				};
				const check = () => {
					if (readySignal.aborted) return abort();
					const errors = diagnostics.errors;
					const fatal = errors.filter(
						(error) => error.origin !== "notebook" || error.phase === "serialization" || error.phase === "transport",
					);
					if (fatal.length) {
						cleanup();
						reject(new DiagnosticError(fatal));
						return;
					}
					if (state.state.inputRevision === null || state.state.pending) return;
					cleanup();
					if (errors.length) reject(new DiagnosticError(errors));
					else resolve(state.state);
				};
				unsubscribeState = state.subscribe(check);
				unsubscribeDiagnostics = diagnostics.subscribe(check);
				readySignal.addEventListener("abort", abort, { once: true });
				check();
			});
		},
		read(selector, readOptions = {}) {
			try {
				const active = requireSession();
				if (!prepared) throw new Error("Notebook source could not be prepared");
				return readNotebook(selector, readOptions, {
					values,
					inspection: prepared.inspection,
					attachments: active.attachments,
					baseUrl: active.options.baseUrl,
					signal: active.signal,
				});
			} catch (cause) {
				return Promise.reject(cause);
			}
		},
		updateVariables(patch) {
			const active = requireSession();
			assertNoRuntimeBuiltinCollisions(active.runtime, patch);
			const names = new Set(Object.keys(patch));
			clearInputs(names);
			beginCurrentInput(names);
			active.variablesSync.set(patch);
		},
		replaceVariables(next) {
			const active = requireSession();
			assertNoRuntimeBuiltinCollisions(active.runtime, next);
			clearInputs(new Set([...Object.keys(variables), ...Object.keys(next)]));
			active.variablesSync.replace(next);
		},
		setInputs(next) {
			const active = requireSession();
			inputs = { ...next };
			active.viewSync.set(inputs);
		},
		dispose,
	};
}

function selectedIndexes(selection: readonly number[] | undefined, count: number): Set<number> {
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
