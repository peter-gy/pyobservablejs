import type { RenderProps } from "@anywidget/types";
import type { CompositionHost, WidgetModel } from "./types";

const MODEL_LOOKUP_TIMEOUT_MS = 1_000;
const MODEL_LOOKUP_RETRY_MS = 25;

/**
 * Resolve child widget models through anywidget's native host surface, with
 * `widget_manager` as the same model lookup path used by anywidget's host.
 */
export function createCompositionHost(
	host: RenderProps<WidgetModel>["host"] | undefined,
	model: RenderProps<WidgetModel>["model"],
): CompositionHost {
	return {
		getModel(ref, signal) {
			parseWidgetRef(ref);
			if (host?.getModel) {
				return getModelWithRetry(() => host.getModel<WidgetModel>(ref), signal);
			}
			return getModelFromWidgetManager(model, ref, signal);
		},
	};
}

/**
 * Resolve a child model through native anywidget composition.
 */
export async function resolveCellModel(
	host: CompositionHost,
	ref: string,
	signal: AbortSignal,
): Promise<RenderProps<WidgetModel>["model"]> {
	parseWidgetRef(ref);
	if (signal.aborted) throw new Error(`Unable to resolve cell widget ${ref}`);
	const childModel = await host.getModel(ref, signal);
	if (signal.aborted) throw new Error(`Unable to resolve cell widget ${ref}`);
	if (!childModel) throw new Error(`Unknown widget model ${ref}`);
	return childModel;
}

export function parseWidgetRef(ref: string): string {
	if (typeof ref !== "string" || !ref.startsWith("anywidget:")) {
		throw new Error(`Malformed widget reference: ${String(ref)}`);
	}
	const modelId = ref.slice("anywidget:".length);
	if (!modelId) throw new Error(`Malformed widget reference: ${String(ref)}`);
	return modelId;
}

async function getModelFromWidgetManager(
	model: RenderProps<WidgetModel>["model"],
	ref: string,
	signal: AbortSignal | undefined,
): Promise<RenderProps<WidgetModel>["model"] | undefined> {
	const modelId = parseWidgetRef(ref);
	const manager = model.widget_manager;
	if (!manager || typeof manager.get_model !== "function") {
		throw new Error("This anywidget host cannot resolve child widget models");
	}
	return getModelWithRetry(() => manager.get_model(modelId), signal);
}

async function getModelWithRetry(
	getModel: () =>
		| Promise<RenderProps<WidgetModel>["model"] | undefined>
		| RenderProps<WidgetModel>["model"]
		| undefined,
	signal: AbortSignal | undefined,
): Promise<RenderProps<WidgetModel>["model"] | undefined> {
	const deadline = Date.now() + MODEL_LOOKUP_TIMEOUT_MS;
	let lastError: unknown;
	const lookup = async (): Promise<RenderProps<WidgetModel>["model"] | undefined> => {
		if (signal?.aborted) return undefined;
		try {
			const childModel = await getModel();
			if (childModel) return childModel;
		} catch (error) {
			// Child models can be registered just after the parent render starts.
			lastError = error;
		}
		if (Date.now() >= deadline) {
			if (lastError !== undefined) throw lastError;
			return undefined;
		}
		await waitForModelRetry(signal);
		return lookup();
	};
	return lookup();
}

function waitForModelRetry(signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		let timeout: ReturnType<typeof setTimeout>;
		const done = () => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", done);
			resolve();
		};
		timeout = setTimeout(done, MODEL_LOOKUP_RETRY_MS);
		signal?.addEventListener("abort", done, { once: true });
	});
}
