import type { AnyModel } from "@anywidget/types";
import { createModuleLoader, type ModuleLoaderOptions } from "./module-loader.ts";
import { createModuleReader, type ModuleReaderOptions } from "./protocol.ts";
import type { AnyWidgetBundleAppModule, AnyWidgetBundleModel, AnyWidgetState } from "./types.ts";

export type AnyWidgetBundleLoaderOptions = ModuleLoaderOptions & ModuleReaderOptions;

type BundleState = {
	signal: AbortSignal;
	load(path: string): Promise<unknown>;
};

// One model owns one reader and module graph. Sharing preserves ESM identity
// across its views, and the model signal owns transport and URL cleanup.
const states = new WeakMap<AnyWidgetBundleModel, BundleState>();

export async function loadAnyWidgetBundleApp<ModelState extends AnyWidgetState>(
	model: AnyModel<ModelState>,
	path: string,
	signal: AbortSignal,
	options: AnyWidgetBundleLoaderOptions = {},
): Promise<AnyWidgetBundleAppModule<ModelState>> {
	if (signal.aborted) throw abortError();
	const bundleModel = model as unknown as AnyWidgetBundleModel;
	const state = stateFor(bundleModel, signal, options);
	const module = await state.load(path);
	const app = defaultExport(module);
	if (!isAppModule<ModelState>(app)) {
		throw new Error("Anywidget bundle module must export a widget definition.");
	}
	return app;
}

function stateFor(
	model: AnyWidgetBundleModel,
	signal: AbortSignal,
	options: AnyWidgetBundleLoaderOptions,
): BundleState {
	const existing = states.get(model);
	if (existing && !existing.signal.aborted) return existing;
	const reader = createModuleReader(model, signal, options);
	const loader = createModuleLoader(reader, signal, options);
	const state: BundleState = { signal, load: (path) => loader.import(path) };
	states.set(model, state);
	signal.addEventListener(
		"abort",
		() => {
			reader.dispose();
			loader.dispose();
			if (states.get(model) === state) states.delete(model);
		},
		{ once: true },
	);
	return state;
}

function defaultExport(module: unknown): unknown {
	if (module && typeof module === "object" && Object.prototype.hasOwnProperty.call(module, "default")) {
		return (module as { default: unknown }).default;
	}
	throw new Error("Anywidget bundle app module must have a default export.");
}

function isAppModule<ModelState extends AnyWidgetState>(value: unknown): value is AnyWidgetBundleAppModule<ModelState> {
	return typeof value === "function" || (value !== null && typeof value === "object");
}

function abortError(): DOMException {
	return new DOMException("Anywidget bundle module request aborted", "AbortError");
}

export type { AnyWidgetBundleApp, AnyWidgetBundleAppModule, AnyWidgetState } from "./types.ts";
