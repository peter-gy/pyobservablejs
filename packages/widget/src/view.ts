import { isNumber } from "@pyobservablejs/runtime/values";
import type { RenderProps } from "@anywidget/types";
import { mountNotebook, type MountedNotebook, type RuntimeValue, type Variables } from "@pyobservablejs/runtime";
import {
	decodeVariables,
	isRecord,
	readNotebookOptions,
	readNotebookSource,
	readNotebookSessionRef,
	readSelectedCellIndexes,
	readWireValues,
	SESSION_MODEL_CHANGE_EVENTS,
	VIEW_MODEL_CHANGE_EVENTS,
	type AnyWidgetModel,
	type WidgetModel,
} from "./model";
import { ReadbackPublisher } from "./readback";
import { connectRequests, type ReadySnapshot } from "./requests";
import { isWritableSyncedViewValue, reviveSyncedValue, sameWireValue, toWireValue, type WireValues } from "./values";
import { DiagnosticPublisher, showError, type DiagnosticContext, type DiagnosticScope } from "./errors";

export function renderNotebookViewModel(props: RenderProps<WidgetModel>, diagnostics: DiagnosticPublisher): void {
	let current = new AbortController();
	const previousSequence = props.model.get("_diagnostics")?.sequence;
	let appliedSequence =
		isNumber(previousSequence) && Number.isSafeInteger(previousSequence) && previousSequence >= 0
			? previousSequence
			: 0;
	let scope = diagnostics.start(() => appliedSequence);
	let publisher: ReadbackPublisher | undefined;
	let failed = false;
	const fail = (cause: unknown, context: DiagnosticContext) => {
		if (props.signal.aborted || failed) return;
		failed = true;
		scope.report(cause, context);
		diagnostics.flush();
		publisher?.fail(cause);
		current.abort();
		showError(props.el, cause);
	};
	try {
		publisher = new ReadbackPublisher(props.model, props.signal, {
			update: (errors) => scope.replace("serialization", errors),
			fail: (cause) =>
				fail(cause, {
					phase: "transport",
					component: "packages/widget/src/readback.ts",
					operation: "publish readback",
				}),
		});
	} catch (cause) {
		fail(cause, { phase: "transport", component: "packages/widget/src/model.ts", operation: "read view options" });
		return;
	}
	const readback = publisher;
	const rerender = () => {
		try {
			current.abort();
			current = new AbortController();
			failed = false;
			scope = diagnostics.start(() => appliedSequence);
			const attempt = scope;
			const signal = AbortSignal.any([props.signal, current.signal]);
			const publish = readback.start();
			const onFailure = (cause: unknown, context: DiagnosticContext) => {
				if (!signal.aborted) fail(cause, context);
			};
			void mountView(
				props,
				signal,
				readback.captureState,
				(state) => {
					try {
						publish(state);
					} catch (cause) {
						onFailure(cause, {
							phase: "serialization",
							component: "packages/widget/src/readback.ts",
							operation: "capture readback",
						});
					}
				},
				rerender,
				attempt,
				onFailure,
				(sequence) => {
					appliedSequence = sequence;
				},
				() => ({ readback: readback.snapshot(), diagnostics: diagnostics.snapshot() }),
			).catch((cause) => {
				onFailure(cause, { phase: "rendering", component: "packages/widget/src/view.ts", operation: "mount view" });
			});
		} catch (cause) {
			fail(cause, { phase: "rendering", component: "packages/widget/src/view.ts", operation: "restart view" });
		}
	};
	for (const event of VIEW_MODEL_CHANGE_EVENTS) props.model.on(event, rerender);
	props.signal.addEventListener(
		"abort",
		() => {
			current.abort();
			for (const event of VIEW_MODEL_CHANGE_EVENTS) props.model.off(event, rerender);
		},
		{ once: true },
	);
	rerender();
}

async function mountView(
	props: RenderProps<WidgetModel>,
	signal: AbortSignal,
	captureState: boolean,
	onState: ReturnType<ReadbackPublisher["start"]>,
	onDefinitionChange: () => void,
	diagnostics: DiagnosticScope,
	onFailure: (cause: unknown, context: DiagnosticContext) => void,
	onSequence: (sequence: number) => void,
	snapshot: () => ReadySnapshot,
): Promise<void> {
	let selection: ReturnType<typeof readSelectedCellIndexes>;
	let model: AnyWidgetModel;
	try {
		selection = readSelectedCellIndexes(props.model);
		const ref = readNotebookSessionRef(props.model);
		model = await resolveSessionModel(props, ref, signal);
		if (signal.aborted) return;
		if (model.get("_model_role") !== "session")
			throw new Error("NotebookView reference does not resolve to a Notebook session");
	} catch (cause) {
		onFailure(cause, { phase: "transport", component: "packages/widget/src/view.ts", operation: "resolve session" });
		return;
	}
	let mounted: MountedNotebook | undefined;
	let publishDatasets: (() => void) | undefined;
	let sharedValues = readWireValues(model.get("_view_values"));
	let publishingInputs: WireValues | undefined;
	let lastSequence = variableUpdate(model).seq;
	onSequence(lastSequence);
	const guard =
		<Arguments extends unknown[]>(
			callback: (...args: Arguments) => void,
			operation: string,
			phase: DiagnosticContext["phase"] = "transport",
		) =>
		(...args: Arguments) => {
			if (signal.aborted) return;
			try {
				callback(...args);
			} catch (cause) {
				onFailure(cause, { phase, component: "packages/widget/src/view.ts", operation });
			}
		};
	const onInput = guard((name: string, value: RuntimeValue) => {
		const context: DiagnosticContext = {
			phase: "serialization",
			component: "packages/widget/src/values.ts",
			operation: "serialize browser input",
			variable: name,
		};
		let wireValue;
		try {
			wireValue = toWireValue(value);
			diagnostics.clear(context);
		} catch (cause) {
			diagnostics.report(cause, context);
			return;
		}
		if (!isWritableSyncedViewValue(wireValue)) return;
		if (Object.prototype.hasOwnProperty.call(sharedValues, name) && sameWireValue(sharedValues[name], wireValue))
			return;
		sharedValues = { ...sharedValues, [name]: wireValue };
		const previous = publishingInputs;
		publishingInputs = sharedValues;
		try {
			model.set("_view_values", sharedValues);
		} finally {
			publishingInputs = previous;
		}
		model.save_changes();
	}, "publish browser input");
	const onSharedInputs = guard(() => {
		const incoming = model.get("_view_values");
		// Skip our exact publication while accepting reentrant writes from other views.
		if (publishingInputs !== undefined && incoming === publishingInputs) return;
		sharedValues = readWireValues(incoming);
		mounted?.setInputs(decodeInputs(sharedValues));
	}, "apply shared inputs");
	const clearInputs = (names: readonly string[]) => {
		const next = { ...sharedValues };
		for (const name of names) delete next[name];
		if (sameWireValue(sharedValues, next)) return;
		sharedValues = next;
		model.set("_view_values", next);
		model.save_changes();
	};
	const onVariables = guard(() => {
		const patch = variableUpdate(model);
		if (!mounted || patch.seq <= lastSequence) return;
		lastSequence = patch.seq;
		onSequence(lastSequence);
		if (patch.kind === "set") {
			const variables = decodeVariables(patch.values);
			clearInputs(Object.keys(variables));
			mounted.updateVariables(variables);
		} else if (patch.kind === "replace") {
			clearInputs([...Object.keys(readWireValues(model.get("_variables"))), ...Object.keys(patch.values)]);
			mounted.replaceVariables(decodeVariables(patch.values));
		}
	}, "apply Python variables");
	for (const event of SESSION_MODEL_CHANGE_EVENTS) model.on(event, onDefinitionChange);
	model.on("change:_view_values", onSharedInputs);
	model.on("change:_variable_update", onVariables);
	signal.addEventListener(
		"abort",
		() => {
			try {
				for (const event of SESSION_MODEL_CHANGE_EVENTS) model.off(event, onDefinitionChange);
				model.off("change:_view_values", onSharedInputs);
				model.off("change:_variable_update", onVariables);
			} catch (cause) {
				diagnostics.report(cause, {
					phase: "transport",
					component: "packages/widget/src/view.ts",
					operation: "unsubscribe session",
				});
			}
			try {
				mounted?.dispose();
			} catch (cause) {
				diagnostics.report(cause, {
					phase: "rendering",
					component: "packages/widget/src/view.ts",
					operation: "dispose view",
				});
			}
		},
		{ once: true },
	);
	mounted = mountNotebook(props.el, readNotebookSource(model), {
		...readNotebookOptions(model),
		inputs: decodeInputs(sharedValues),
		selection: selection === null ? undefined : [...selection],
		captureState,
		signal,
		onState,
		onInput,
		onDatasets: guard(() => publishDatasets?.(), "publish dataset metadata"),
		onDiagnostics: (errors) => diagnostics.replace("runtime", errors),
	});
	const notebook = mounted;
	publishDatasets = connectRequests(props.model, notebook, signal, {
		checkpoint: () => {
			onState(notebook.state);
			diagnostics.replace("runtime", notebook.diagnostics);
			return snapshot();
		},
		onError: (cause, operation) =>
			onFailure(cause, { phase: "transport", component: "packages/widget/src/requests.ts", operation }),
		ready: async (sequence, requestSignal) => {
			if (!captureState) throw new Error("Readiness requires capture_state=True");
			if (lastSequence < sequence) {
				await new Promise<void>((resolve, reject) => {
					const cleanup = () => {
						model.off("change:_variable_update", check);
						requestSignal.removeEventListener("abort", abort);
					};
					const check = () => {
						if (lastSequence >= sequence) {
							cleanup();
							resolve();
						}
					};
					const abort = () => {
						cleanup();
						reject(requestSignal.reason);
					};
					model.on("change:_variable_update", check);
					requestSignal.addEventListener("abort", abort, { once: true });
					if (requestSignal.aborted) abort();
					else check();
				});
			}
			await notebook.ready({ signal: requestSignal });
		},
	});
}

type VariableUpdate = {
	seq: number;
	kind: "set" | "replace" | undefined;
	values: WireValues;
};

function variableUpdate(model: AnyWidgetModel): VariableUpdate {
	const value = model.get("_variable_update");
	if (!isRecord(value)) return { seq: 0, kind: undefined, values: {} };
	return {
		seq: isNumber(value.seq) && Number.isSafeInteger(value.seq) && value.seq >= 0 ? value.seq : 0,
		kind: value.kind === "set" || value.kind === "replace" ? value.kind : undefined,
		values: readWireValues(value.values),
	};
}

function decodeInputs(values: WireValues): Variables {
	return Object.fromEntries(
		Object.entries(values)
			.filter(([, value]) => isWritableSyncedViewValue(value))
			.map(([name, value]) => [name, reviveSyncedValue(value)]),
	);
}

function resolveSessionModel(
	props: RenderProps<WidgetModel>,
	ref: string,
	signal: AbortSignal,
): Promise<AnyWidgetModel> {
	signal.throwIfAborted();
	const lookup = Promise.resolve().then(() => {
		signal.throwIfAborted();
		return props.host.getModel<WidgetModel>(ref);
	});
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		lookup.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}
