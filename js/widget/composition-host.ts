import type { RenderProps } from "@anywidget/types";
import { delay } from "./abort";
import { ensureLocalCellExports } from "./cell-registry";
import type { CellExports, CompositionHost, ResolvedCell, ResolvedCellWidget, WidgetModel } from "./types";

export type RenderChildWidget = (props: RenderProps<WidgetModel> & { signal?: AbortSignal }) => void;

/**
 * Adapt the anywidget composition host to the smaller interface used by the
 * notebook renderer.
 */
export function createCompositionHost(host: RenderProps<WidgetModel>["host"]): CompositionHost {
	return {
		getModel(ref) {
			return host.getModel<WidgetModel>(ref);
		},
		async getWidget(ref) {
			return host.getWidget<CellExports>(ref);
		},
	};
}

/**
 * Build a composition host from the widget manager when the frontend host does
 * not pass `RenderProps.host`.
 */
export function createWidgetManagerCompositionHost(
	model: RenderProps<WidgetModel>["model"],
	signal: AbortSignal,
	renderChildWidget: RenderChildWidget,
): CompositionHost | undefined {
	const manager = model.widget_manager as
		| { get_model?: (modelId: string) => Promise<RenderProps<WidgetModel>["model"]> }
		| undefined;
	if (!manager?.get_model) return undefined;

	const resolveModel = manager.get_model.bind(manager);
	const models = new Map<string, Promise<RenderProps<WidgetModel>["model"]>>();
	const host: CompositionHost = {
		async getModel(ref) {
			const modelId = parseWidgetRef(ref);
			const existing = models.get(modelId);
			if (existing) return existing;
			const pending = resolveModel(modelId)
				.then((childModel) => {
					if (!childModel) throw new Error(`Unknown widget model ${modelId}`);
					return childModel;
				})
				.catch((error: unknown) => {
					models.delete(modelId);
					throw error;
				});
			models.set(modelId, pending);
			return pending;
		},
		async getWidget(ref) {
			const childModel = await host.getModel(ref);
			return {
				exports: ensureLocalCellExports(childModel),
				async render({ el, signal: childSignal }) {
					renderChildWidget({
						model: childModel,
						el,
						signal: childSignal ?? signal,
						host,
					} as RenderProps<WidgetModel>);
				},
			};
		},
	};
	return host;
}

/**
 * Resolve a child widget and retry while the host is still creating the binding.
 */
export async function resolveCellWidget(
	host: CompositionHost,
	ref: string,
	signal: AbortSignal,
): Promise<ResolvedCell> {
	parseWidgetRef(ref);
	return resolveCellWidgetAttempt(host, ref, signal, performance.now() + 5000);
}

export function parseWidgetRef(ref: string): string {
	if (typeof ref !== "string" || !ref.startsWith("anywidget:")) {
		throw new Error(`Malformed widget reference: ${String(ref)}`);
	}
	const modelId = ref.slice("anywidget:".length);
	if (!modelId) throw new Error(`Malformed widget reference: ${String(ref)}`);
	return modelId;
}

async function resolveCellWidgetAttempt(
	host: CompositionHost,
	ref: string,
	signal: AbortSignal,
	deadline: number,
	lastError?: unknown,
): Promise<ResolvedCell> {
	if (signal.aborted || performance.now() >= deadline) {
		throw lastError ?? new Error(`Unable to resolve cell widget ${ref}`);
	}
	let child: ResolvedCellWidget;
	let childModel: RenderProps<WidgetModel>["model"];
	try {
		[child, childModel] = await Promise.all([host.getWidget(ref), host.getModel(ref)]);
	} catch (error) {
		if (!isRetryableResolutionError(error)) throw error;
		await delay(75, signal);
		return resolveCellWidgetAttempt(host, ref, signal, deadline, error);
	}
	if (!isCellExports(child.exports)) {
		throw new Error(`Cell widget ${ref} does not expose pyobservablejs cell exports`);
	}
	return [child, childModel];
}

function isRetryableResolutionError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return /not ready|not found|no binding found|unknown widget model|model .*missing|widget .*missing|no model/i.test(
		error.message,
	);
}

function isCellExports(value: unknown): value is CellExports {
	if (value === null || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.bindRuntime === "function" &&
		typeof candidate.unbindRuntime === "function" &&
		typeof candidate.prepareComposedRender === "function"
	);
}
