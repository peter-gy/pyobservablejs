import type { AnyWidget, InitializeProps, RenderProps } from "@anywidget/types";
import { ensureLifecycleSignal, instantiateAnyWidgetBundleApp } from "./entry.ts";
import type { AnyWidgetBundleApp, AnyWidgetBundleAppModule, AnyWidgetState } from "./types.ts";

type Cleanup = () => void | Promise<void>;
type ListenerModel = { off(): void };

class LifecycleCleanupError extends Error {
	constructor(readonly errors: readonly unknown[]) {
		super("Anywidget bundle lifecycle cleanup failed.");
		this.name = "LifecycleCleanupError";
	}
}

// Host signals own model and view lifetimes. Each generation signal owns one
// HMR app version, while operation promises serialize lifecycle callbacks.
type ViewState<ModelState extends AnyWidgetState> = {
	props: RenderProps<ModelState>;
	fallback?: AbortController;
	cleanup?: Cleanup;
	cleanupOperation?: Promise<void>;
	operation: Promise<void>;
	disposal?: Promise<void>;
	disposed: boolean;
	onAbort: () => void;
};

type DevelopmentModel<ModelState extends AnyWidgetState> = {
	props?: InitializeProps<ModelState>;
	fallback?: AbortController;
	app?: AnyWidgetBundleApp<ModelState>;
	initializeCleanup?: Cleanup;
	cleanupOperation?: Promise<void>;
	views: Set<ViewState<ModelState>>;
	generation: AbortController;
	operation: Promise<void>;
	disposal?: Promise<void>;
	disposed: boolean;
	onAbort?: () => void;
};

type InitializeResult<ModelState extends AnyWidgetState> = Awaited<
	ReturnType<NonNullable<AnyWidgetBundleApp<ModelState>["initialize"]>>
>;

export type AnyWidgetBundleDevelopmentEntry<ModelState extends AnyWidgetState> = {
	widget: AnyWidget<ModelState>;
	update(app: AnyWidgetBundleAppModule<ModelState>): Promise<void>;
	dispose(): Promise<void>;
};

export function createAnyWidgetBundleDevelopmentEntry<ModelState extends AnyWidgetState>(
	initialApp: AnyWidgetBundleAppModule<ModelState>,
): AnyWidgetBundleDevelopmentEntry<ModelState> {
	let currentApp = initialApp;
	const models = new Set<DevelopmentModel<ModelState>>();

	const widget: AnyWidget<ModelState> = () => {
		const state: DevelopmentModel<ModelState> = {
			views: new Set(),
			generation: new AbortController(),
			operation: Promise.resolve(),
			disposed: false,
		};

		const initialize = async (props: InitializeProps<ModelState>) => {
			if (state.props) throw new Error("Anywidget bundle initialized more than once.");
			const lifecycle = ensureLifecycleSignal(props);
			state.props = lifecycle.props;
			state.fallback = lifecycle.fallback;
			models.add(state);
			state.onAbort = () => ignoreAbortCleanupError(disposeModel(models, state));
			lifecycle.props.signal.addEventListener("abort", state.onAbort, { once: true });
			const operation = runAfter(state.operation, () => startModel(state, currentApp));
			state.operation = operation;
			try {
				await operation;
			} catch (error) {
				const aborted = state.props.signal.aborted;
				const disposal = disposeModel(models, state);
				if (aborted) {
					await disposal.catch(() => undefined);
					return;
				}
				await settleOperations([Promise.reject(error), disposal]);
			}
			return () => disposeModel(models, state);
		};

		const render = async (props: RenderProps<ModelState>) => {
			if (!state.props) throw new Error("Anywidget bundle rendered before initialization.");
			await state.operation;
			const lifecycle = ensureLifecycleSignal(props);
			if (state.disposed || lifecycle.props.signal.aborted) {
				lifecycle.fallback?.abort();
				return;
			}
			const view: ViewState<ModelState> = {
				props: lifecycle.props,
				fallback: lifecycle.fallback,
				operation: Promise.resolve(),
				disposed: false,
				onAbort: () => ignoreAbortCleanupError(disposeView(state, view)),
			};
			state.views.add(view);
			lifecycle.props.signal.addEventListener("abort", view.onAbort, { once: true });
			const operation = scheduleViewRender(state, view);
			try {
				await operation;
			} catch (error) {
				const aborted = view.props.signal.aborted || state.props.signal.aborted;
				const disposal = disposeView(state, view);
				if (aborted) {
					await disposal.catch(() => undefined);
					return;
				}
				await settleOperations([Promise.reject(error), disposal]);
			}
			return () => disposeView(state, view);
		};

		return { initialize, render };
	};

	return {
		widget,
		async update(app) {
			const activeModels = [...models].filter((state) => !state.disposed);
			currentApp = app;
			await settleOperations(
				activeModels.map((state) => {
					const operation = runAfter(state.operation, async () => {
						if (state.disposed) return;
						await restartModel(state, app);
					});
					state.operation = operation;
					return operation;
				}),
			);
		},
		async dispose() {
			await settleOperations([...models].map((state) => disposeModel(models, state)));
		},
	};
}

async function startModel<ModelState extends AnyWidgetState>(
	state: DevelopmentModel<ModelState>,
	appModule: AnyWidgetBundleAppModule<ModelState>,
): Promise<void> {
	const props = state.props;
	if (!props || state.disposed || props.signal.aborted) return;
	const generation = state.generation;
	let app: AnyWidgetBundleApp<ModelState>;
	try {
		app = await instantiateAnyWidgetBundleApp(appModule);
	} catch (error) {
		if (!isCurrent(state, generation)) return;
		throw error;
	}
	if (!isCurrent(state, generation)) return;
	state.app = app;
	let result: InitializeResult<ModelState>;
	try {
		result = await app.initialize?.({
			...props,
			signal: AbortSignal.any([props.signal, generation.signal]),
		});
	} catch (error) {
		if (!isCurrent(state, generation)) return;
		throw error;
	}
	if (!isCurrent(state, generation)) {
		// A generation can end while initialization is settling. Preserve any late
		// cleanup for the final teardown pass.
		state.initializeCleanup = typeof result === "function" ? (result as Cleanup) : undefined;
		return;
	}
	state.initializeCleanup = typeof result === "function" ? (result as Cleanup) : undefined;
}

async function renderView<ModelState extends AnyWidgetState>(
	state: DevelopmentModel<ModelState>,
	view: ViewState<ModelState>,
): Promise<void> {
	if (state.disposed || view.disposed || view.props.signal.aborted) return;
	const app = state.app;
	if (!app) throw new Error("Anywidget bundle rendered before initialization.");
	const generation = state.generation;
	let cleanup: Awaited<ReturnType<NonNullable<typeof app.render>>>;
	try {
		cleanup = await app.render?.({
			...view.props,
			signal: AbortSignal.any([view.props.signal, generation.signal]),
		});
	} catch (error) {
		if (!isViewCurrent(state, view, generation)) return;
		throw error;
	}
	view.cleanup = typeof cleanup === "function" ? cleanup : undefined;
}

async function restartModel<ModelState extends AnyWidgetState>(
	state: DevelopmentModel<ModelState>,
	appModule: AnyWidgetBundleAppModule<ModelState>,
): Promise<void> {
	const props = state.props;
	if (state.disposed || !props || props.signal.aborted) return;
	state.generation.abort();
	state.app = undefined;
	const views = [...state.views].filter((view) => !view.disposed);
	// Views depend on initialized model state. Finish their cleanup before model
	// cleanup, then initialize the replacement before rerendering survivors.
	await settleTeardown(
		views.map((view) => settleViewGeneration(view)),
		() => cleanupModel(state),
	);
	if (state.disposed) return;
	state.generation = new AbortController();
	await startModel(state, appModule);
	if (state.disposed) return;
	await settleOperations(views.filter((view) => !view.disposed).map((view) => scheduleViewRender(state, view)));
}

function disposeModel<ModelState extends AnyWidgetState>(
	models: Set<DevelopmentModel<ModelState>>,
	state: DevelopmentModel<ModelState>,
): Promise<void> {
	if (state.disposal) return state.disposal;
	state.disposed = true;
	state.generation.abort();
	state.app = undefined;
	if (state.props && state.onAbort) state.props.signal.removeEventListener("abort", state.onAbort);
	state.fallback?.abort();
	const operation = state.operation;
	const viewDisposals = [...state.views].map((view) => disposeView(state, view));
	const teardown = settleTeardown(viewDisposals, () => cleanupModel(state));
	const disposal = (async () => {
		try {
			await Promise.allSettled([operation]);
			const errors = await collectOperationErrors([teardown]);
			// Initialization may publish its cleanup after teardown first checked it.
			errors.push(...(await collectOperationErrors([cleanupModel(state)])));
			throwOperationErrors(errors);
		} finally {
			models.delete(state);
		}
	})();
	state.disposal = disposal;
	return disposal;
}

function disposeView<ModelState extends AnyWidgetState>(
	state: DevelopmentModel<ModelState>,
	view: ViewState<ModelState>,
): Promise<void> {
	if (view.disposal) return view.disposal;
	view.disposed = true;
	view.props.signal.removeEventListener("abort", view.onAbort);
	view.fallback?.abort();
	const operation = view.operation;
	const disposal = (async () => {
		try {
			await Promise.allSettled([operation]);
			await cleanupView(view);
		} finally {
			state.views.delete(view);
		}
	})();
	view.disposal = disposal;
	return disposal;
}

function cleanupView<ModelState extends AnyWidgetState>(view: ViewState<ModelState>): Promise<void> {
	if (view.cleanupOperation) return view.cleanupOperation;
	const cleanup = view.cleanup;
	view.cleanup = undefined;
	let operation!: Promise<void>;
	operation = (async () => {
		try {
			await settleListenerCleanup(view.props.model, cleanup);
		} finally {
			if (view.cleanupOperation === operation) view.cleanupOperation = undefined;
		}
	})();
	view.cleanupOperation = operation;
	return operation;
}

function cleanupModel<ModelState extends AnyWidgetState>(state: DevelopmentModel<ModelState>): Promise<void> {
	if (state.cleanupOperation) return state.cleanupOperation;
	const cleanup = takeInitializeCleanup(state);
	let operation!: Promise<void>;
	operation = (async () => {
		try {
			await settleListenerCleanup(state.props?.model, cleanup);
		} finally {
			if (state.cleanupOperation === operation) state.cleanupOperation = undefined;
		}
	})();
	state.cleanupOperation = operation;
	return operation;
}

async function settleViewGeneration<ModelState extends AnyWidgetState>(view: ViewState<ModelState>): Promise<void> {
	await Promise.allSettled([view.operation]);
	await cleanupView(view);
}

function scheduleViewRender<ModelState extends AnyWidgetState>(
	state: DevelopmentModel<ModelState>,
	view: ViewState<ModelState>,
): Promise<void> {
	const operation = runAfter(view.operation, () => renderView(state, view));
	view.operation = operation;
	return operation;
}

async function runCleanup(cleanup: Cleanup | undefined): Promise<void> {
	if (cleanup) await cleanup();
}

function takeInitializeCleanup<ModelState extends AnyWidgetState>(
	state: DevelopmentModel<ModelState>,
): Cleanup | undefined {
	const cleanup = state.initializeCleanup;
	state.initializeCleanup = undefined;
	return cleanup;
}

function ignoreAbortCleanupError(operation: Promise<void>): void {
	void operation.catch(() => undefined);
}

async function settleOperations(operations: readonly Promise<unknown>[]): Promise<void> {
	throwOperationErrors(await collectOperationErrors(operations));
}

async function settleTeardown(
	viewOperations: readonly Promise<unknown>[],
	cleanupInitialize: () => Promise<void>,
): Promise<void> {
	const errors = await collectOperationErrors(viewOperations);
	errors.push(...(await collectOperationErrors([cleanupInitialize()])));
	throwOperationErrors(errors);
}

async function settleListenerCleanup(model: ListenerModel | undefined, cleanup: Cleanup | undefined): Promise<void> {
	const errors: unknown[] = [];
	try {
		// Remove registered callbacks before user cleanup, which may mutate
		// the model synchronously.
		model?.off();
	} catch (error) {
		errors.push(error);
	}
	errors.push(...(await collectOperationErrors([runCleanup(cleanup)])));
	throwOperationErrors(errors);
}

async function collectOperationErrors(operations: readonly Promise<unknown>[]): Promise<unknown[]> {
	const results = await Promise.allSettled(operations);
	return results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
}

function throwOperationErrors(errors: readonly unknown[]): void {
	const uniqueErrors = [...new Set(errors)];
	if (uniqueErrors.length === 1) throw uniqueErrors[0];
	if (uniqueErrors.length > 1) throw new LifecycleCleanupError(uniqueErrors);
}

function isViewCurrent<ModelState extends AnyWidgetState>(
	state: DevelopmentModel<ModelState>,
	view: ViewState<ModelState>,
	generation: AbortController,
): boolean {
	return isCurrent(state, generation) && !view.disposed && !view.props.signal.aborted;
}

function isCurrent<ModelState extends AnyWidgetState>(
	state: DevelopmentModel<ModelState>,
	generation: AbortController,
): boolean {
	return !state.disposed && !generation.signal.aborted && !state.props?.signal.aborted;
}

function runAfter(previous: Promise<void>, operation: () => Promise<void>): Promise<void> {
	// Run the next step after either outcome so cleanup and later HMR work still
	// reach the serialized queue.
	return previous.then(operation, operation);
}
