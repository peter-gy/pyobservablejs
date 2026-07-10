import type { AnyModel, AnyWidget, InitializeProps, RenderProps } from "@anywidget/types";
import type { AnyWidgetBundleApp, AnyWidgetBundleAppModule, AnyWidgetState } from "./types";

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
		let appPromise: Promise<AnyWidgetBundleApp<ModelState>> | undefined;

		const initialize = async (props: InitializeProps<ModelState>) => {
			if (appPromise) throw new Error("Anywidget bundle initialized more than once.");
			const lifecycle = ensureLifecycleSignal(props);
			try {
				appPromise = instantiateAnyWidgetBundleApp(loadApp(props.model, lifecycle.props.signal));
				const app = await appPromise;
				if (lifecycle.props.signal.aborted) return;
				const result = await app.initialize?.(lifecycle.props);
				// Object results are initialization exports whose identity belongs to the
				// host. Return them directly even when this entry owns the fallback signal.
				if (!lifecycle.fallback || (typeof result === "object" && result !== null)) return result;
				return lifecycleCleanup(lifecycle.fallback, typeof result === "function" ? result : undefined);
			} catch (error) {
				const aborted = lifecycle.props.signal.aborted;
				lifecycle.fallback?.abort();
				if (!aborted) throw error;
			}
		};

		const render = async (props: RenderProps<ModelState>) => {
			if (!appPromise) throw new Error("Anywidget bundle rendered before initialization.");
			const lifecycle = ensureLifecycleSignal(props);
			try {
				const app = await appPromise;
				if (lifecycle.props.signal.aborted) return;
				const cleanup = await app.render?.(lifecycle.props);
				return lifecycle.fallback
					? lifecycleCleanup(lifecycle.fallback, typeof cleanup === "function" ? cleanup : undefined)
					: cleanup;
			} catch (error) {
				const aborted = lifecycle.props.signal.aborted;
				lifecycle.fallback?.abort();
				if (!aborted) throw error;
			}
		};

		return { initialize, render };
	};
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
