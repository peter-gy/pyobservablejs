import { source, options, variables, resolvedSource } from "./request";
import { isNumber, isString } from "@pyobservablejs/runtime/values";
import {
	inspectNotebook,
	createDiagnostic,
	DiagnosticError,
	type EvaluatedNotebook,
	type Diagnostic,
	type EvaluateOptions,
} from "@pyobservablejs/runtime/headless";
import {
	revivePythonValue,
	readSelector,
	readOptions,
	executeRead,
	describeResponse,
	encodeCellResult,
	toWireGraph,
	createWireBudget,
	type WireValues,
} from "@pyobservablejs/protocol";
import type { WireRecord } from "@pyobservablejs/protocol";
type Message = WireRecord;
type Send = <Message extends object>(message: Message, buffers?: readonly DataView[]) => void;
type CreateNotebook = (
	source: Parameters<typeof inspectNotebook>[0],
	options: EvaluateOptions,
) => Omit<EvaluatedNotebook, "inspection"> & { readonly inspection: EvaluatedNotebook["inspection"] | null };

export function createService(send: Send, createNotebook: CreateNotebook) {
	type Source = Parameters<NonNullable<EvaluateOptions["resolveNotebook"]>>[0];
	type ResolvedSource = Awaited<ReturnType<NonNullable<EvaluateOptions["resolveNotebook"]>>>;
	let notebook: ReturnType<CreateNotebook> | undefined;
	let generation = 0;
	let revision = 0;
	let sourceId = 0;
	const backgroundErrors: Diagnostic[] = [];
	const pending = new Map<string, AbortController>();
	const sources = new Map<string, { resolve(value: ResolvedSource): void; reject(cause: Error): void }>();

	function resolveNotebook(specifier: Source, { signal }: { signal: AbortSignal }): Promise<ResolvedSource> {
		signal.throwIfAborted();
		const id = `source-${++sourceId}`;
		return new Promise((resolve, reject) => {
			const cleanup = () => {
				sources.delete(id);
				signal.removeEventListener("abort", abort);
			};
			const abort = () => {
				cleanup();
				reject(new DOMException("Notebook import cancelled", "AbortError"));
			};
			sources.set(id, {
				resolve(value) {
					cleanup();
					resolve(value);
				},
				reject(cause) {
					cleanup();
					reject(cause);
				},
			});
			signal.addEventListener("abort", abort, { once: true });
			send({ type: "source", id, specifier });
		});
	}

	function snapshot(includeInspection = false) {
		if (!notebook) throw new Error("Server has no notebook");
		const native = notebook.state;
		const budget = createWireBudget();
		const serialized = Object.fromEntries(
			Object.entries(native.results).map(([index, result]) => {
				const inspected = notebook?.inspection?.cells[Number(index)];
				const cell = inspected
					? {
							index: inspected.index,
							id: inspected.id,
							key: inspected.key,
							mode: inspected.mode,
							source: inspected.source,
						}
					: undefined;
				return [index, encodeCellResult(result, budget, { offset: 0, cell, origin: "server" })];
			}),
		);
		return {
			generation: String(generation),
			state: {
				revision: ++revision,
				input_revision: native.inputRevision,
				settled_revision: native.settledRevision,
				pending: native.pending,
				graph: toWireGraph(native.graph),
				results: Object.fromEntries(Object.entries(serialized).map(([index, cell]) => [index, cell.value])),
				errors: native.errors,
			},
			inspection: includeInspection ? notebook.inspection : undefined,
			datasets: notebook.datasets,
			diagnostics: [
				...notebook.diagnostics,
				...backgroundErrors,
				...Object.values(serialized).flatMap((cell) => cell.diagnostics),
			],
		};
	}

	async function execute(message: Message, controller: AbortController): Promise<void> {
		if (!isString(message.id)) throw new TypeError("Request id must be a string");
		const id = message.id;
		if (!isString(message.operation)) throw new TypeError("Request operation must be a string");
		const operation = message.operation;
		const phase: Diagnostic["phase"] = "transport";
		try {
			let result: unknown;
			let buffers: DataView[] = [];
			if (operation === "inspect") {
				result = inspectNotebook(source(message.source), options(message.options));
			} else if (operation === "open") {
				if (notebook) throw new Error("Server already has a notebook");
				const settings = options(message.options);
				notebook = createNotebook(source(message.source), {
					...settings,
					variables: decodeVariables(settings.variables ?? {}),
					resolveNotebook,
				});
				generation++;
				result = snapshot(true);
			} else {
				if (!notebook) throw new Error("Server has no notebook");
				switch (operation) {
					case "update":
						notebook.updateVariables(decodeVariables(variables(message.variables)));
						result = snapshot();
						break;
					case "replace":
						notebook.replaceVariables(decodeVariables(variables(message.variables)));
						generation++;
						result = snapshot();
						break;
					case "snapshot":
						result = snapshot();
						break;
					case "ready":
						if (backgroundErrors.length) throw new DiagnosticError(backgroundErrors);
						await notebook.ready({ signal: controller.signal });
						if (backgroundErrors.length) throw new DiagnosticError(backgroundErrors);
						result = snapshot();
						break;

					case "describe": {
						const value = await notebook.read(readSelector(message.selector), {
							...readOptions(message.options),
							format: "native",
							signal: controller.signal,
						});
						result = describeResponse(value);
						break;
					}
					case "discover": {
						const deadline = message.deadline;
						const signal = isNumber(deadline)
							? AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(1, Math.floor(deadline)))])
							: controller.signal;
						try {
							await notebook.discover({ signal });
						} catch (cause) {
							if (!signal.aborted || controller.signal.aborted) throw cause;
						}
						result = snapshot();
						break;
					}
					case "read": {
						({ result, buffers } = await executeRead(
							notebook,
							readSelector(message.selector),
							readOptions(message.options),
							controller.signal,
							"server",
						));
						break;
					}
					default:
						throw new Error(`Unknown server operation: ${operation}`);
				}
			}
			if (!controller.signal.aborted) send({ type: "response", id, result }, buffers);
		} catch (cause) {
			const failure = controller.signal.reason instanceof DiagnosticError ? controller.signal.reason : cause;
			const diagnostics =
				failure instanceof DiagnosticError
					? failure.diagnostics
					: [
							createDiagnostic(failure, {
								origin: "server",
								phase,
								component: "packages/server/src/service.ts",
								operation,
							}),
						];
			if (!controller.signal.aborted || controller.signal.reason instanceof DiagnosticError)
				send({ type: "response", id, error: diagnostics, snapshot: notebook ? snapshot() : undefined });
		} finally {
			pending.delete(id);
		}
	}

	const reportUnhandled = <Cause>(cause: Cause, operation: string) => {
		const diagnostic = createDiagnostic(cause, {
			origin: "notebook",
			phase: "evaluation",
			component: "packages/server/src/service.ts",
			operation,
		});
		if (backgroundErrors.length < 32) backgroundErrors.push(diagnostic);
	};
	const unhandled = (event: PromiseRejectionEvent) => {
		event.preventDefault();
		reportUnhandled(event.reason, "unhandled promise rejection");
	};
	const uncaught = (event: ErrorEvent) => {
		// Browser scheduling notifications have no thrown value and are not notebook failures.
		if (event.error == null) return;
		event.preventDefault();
		reportUnhandled(event.error ?? new Error(event.message), "unhandled exception");
	};
	globalThis.addEventListener("error", uncaught);
	globalThis.addEventListener("unhandledrejection", unhandled);

	const receive = (message: Message) => {
		if (!isString(message.id)) throw new TypeError("Request id must be a string");
		const id = message.id;
		if (message.type === "source") {
			const pendingSource = sources.get(id);
			if (isString(message.error)) pendingSource?.reject(new Error(message.error));
			else pendingSource?.resolve(resolvedSource(message.result));
			return;
		}
		if (message.type === "cancel") {
			pending.get(id)?.abort();
			return;
		}
		if (message.type !== "request" || !isString(message.id) || pending.has(id))
			throw new Error("Invalid server request envelope");
		const controller = new AbortController();
		pending.set(id, controller);
		void execute(message, controller);
	};

	const close = () => {
		globalThis.removeEventListener("unhandledrejection", unhandled);
		globalThis.removeEventListener("error", uncaught);
		for (const controller of pending.values()) controller.abort();
		notebook?.dispose();
		for (const source of sources.values()) source.reject(new Error("Server closed"));
	};
	return { receive, close };
}

function decodeVariables(values: WireValues) {
	return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, revivePythonValue(value)]));
}
