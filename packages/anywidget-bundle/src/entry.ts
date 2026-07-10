import type { AnyModel, AnyWidget, InitializeProps, RenderProps } from "@anywidget/types";
import type { AnyWidgetBundleApp, AnyWidgetBundleAppModule, AnyWidgetState } from "./types.ts";

type LoadApp<ModelState extends AnyWidgetState> = (
	model: AnyModel<ModelState>,
	signal: AbortSignal,
) => AnyWidgetBundleAppModule<ModelState> | Promise<AnyWidgetBundleAppModule<ModelState>>;

export function createAnyWidgetBundleEntry<ModelState extends AnyWidgetState>(
	loadApp: LoadApp<ModelState>,
): AnyWidget<ModelState> {
	return () => {
		// The widget factory runs once per model. Initialization and every view
		// share the same app instance and module graph.
		let state: ModelLifecycle<ModelState> | undefined;

		const initialize = (props: InitializeProps<ModelState>) => {
			if (state) throw new Error("Anywidget bundle initialized more than once.");
			const lifecycle = createModelLifecycle(props);
			const app = Promise.resolve().then(() =>
				instantiateAnyWidgetBundleApp(loadApp(lifecycle.props.model, lifecycle.props.signal)),
			);
			const initialized = initializeApp(app, lifecycle.props);
			const current = { ...lifecycle, app, initialized };
			state = current;
			// anywidget queues inbound custom messages until this hook settles. Return
			// teardown synchronously so the module request scheduled above can receive
			// its response. Render still waits for app initialization below.
			void initialized.catch(() => {});
			return () => disposeModelLifecycle(current);
		};

		const render = async (props: RenderProps<ModelState>) => {
			if (!state) throw new Error("Anywidget bundle rendered before initialization.");
			const lifecycle = ensureLifecycleSignal(props);
			try {
				await state.initialized;
				const app = await state.app;
				if (state.props.signal.aborted || lifecycle.props.signal.aborted) return;
				const cleanup = await app.render?.(lifecycle.props);
				return lifecycle.fallback
					? lifecycleCleanup(lifecycle.fallback, typeof cleanup === "function" ? cleanup : undefined)
					: cleanup;
			} catch (error) {
				const aborted = state.props.signal.aborted || lifecycle.props.signal.aborted;
				lifecycle.fallback?.abort();
				if (!aborted) throw error;
			}
		};

		return { initialize, render };
	};
}

type ModelLifecycle<ModelState extends AnyWidgetState> = {
	props: InitializeProps<ModelState>;
	controller: AbortController;
	app: Promise<AnyWidgetBundleApp<ModelState>>;
	initialized: Promise<ModelCleanup | undefined>;
	disposal?: Promise<void>;
};

type ModelCleanup = () => void | Promise<void>;

function createModelLifecycle<ModelState extends AnyWidgetState>(
	props: InitializeProps<ModelState>,
): Pick<ModelLifecycle<ModelState>, "props" | "controller"> {
	const controller = new AbortController();
	const signal = props.signal ? AbortSignal.any([props.signal, controller.signal]) : controller.signal;
	return { props: { ...props, signal }, controller };
}

async function initializeApp<ModelState extends AnyWidgetState>(
	appPromise: Promise<AnyWidgetBundleApp<ModelState>>,
	props: InitializeProps<ModelState>,
): Promise<ModelCleanup | undefined> {
	const app = await appPromise;
	if (props.signal.aborted) return;
	const result = await app.initialize?.(props);
	if (typeof result === "object" && result !== null) {
		throw new Error("Anywidget bundle initialize must return a cleanup function or nothing.");
	}
	if (props.signal.aborted) {
		if (typeof result === "function") await result();
		return;
	}
	return typeof result === "function" ? result : undefined;
}

async function disposeModelLifecycle<ModelState extends AnyWidgetState>(
	state: ModelLifecycle<ModelState>,
): Promise<void> {
	state.disposal ??= runModelDisposal(state);
	return state.disposal;
}

async function runModelDisposal<ModelState extends AnyWidgetState>(state: ModelLifecycle<ModelState>): Promise<void> {
	state.controller.abort();
	let cleanup: ModelCleanup | undefined;
	try {
		cleanup = await state.initialized;
	} catch (error) {
		if (!state.props.signal.aborted) throw error;
	}
	await cleanup?.();
}

export function ensureLifecycleSignal<Props extends { signal: AbortSignal }>(
	props: Props,
): {
	props: Props;
	fallback?: AbortController;
} {
	// Some hosts omit signal at runtime. Own a fallback signal so callable
	// lifecycle cleanup can abort work before user cleanup.
	if (props.signal) return { props };
	const fallback = new AbortController();
	return { props: { ...props, signal: fallback.signal }, fallback };
}

function lifecycleCleanup(
	controller: AbortController,
	cleanup: (() => void | Promise<void>) | undefined,
): () => Promise<void> {
	return async () => {
		controller.abort();
		await cleanup?.();
	};
}

export async function instantiateAnyWidgetBundleApp<ModelState extends AnyWidgetState>(
	loaded: AnyWidgetBundleAppModule<ModelState> | Promise<AnyWidgetBundleAppModule<ModelState>>,
): Promise<AnyWidgetBundleApp<ModelState>> {
	const module = await loaded;
	const app = typeof module === "function" ? await module() : module;
	if (app === null || typeof app !== "object") {
		throw new Error("Anywidget bundle module must export a widget definition.");
	}
	const candidate = app as { initialize?: unknown; render?: unknown };
	if (candidate.initialize !== undefined && typeof candidate.initialize !== "function") {
		throw new Error("Anywidget bundle initialize must be a function.");
	}
	if (candidate.render !== undefined && typeof candidate.render !== "function") {
		throw new Error("Anywidget bundle render must be a function.");
	}
	if (candidate.initialize === undefined && candidate.render === undefined) {
		throw new Error("Anywidget bundle definition must provide initialize or render.");
	}
	return app as AnyWidgetBundleApp<ModelState>;
}
