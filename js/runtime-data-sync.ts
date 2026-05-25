import type { RenderProps } from "@anywidget/types";
import type { NotebookRuntime } from "@observablehq/notebook-kit/runtime";
import { setRuntimeData } from "./runtime";
import type { NotebookOptions, RuntimeDataSync, ViewTarget, WidgetModel } from "./types";
import { readViewValue, writeViewValue } from "./view";
import { revivePythonValue, sameWireValue, toWireValue } from "./wire";

type RuntimeDataSyncOptions = {
	model: RenderProps<WidgetModel>["model"];
	runtime: NotebookRuntime;
	options: NotebookOptions;
	viewNames: Set<string>;
	signal: AbortSignal;
	onReset(): void;
};

export function createRuntimeDataSync({
	model,
	runtime,
	options,
	viewNames,
	signal,
	onReset,
}: RuntimeDataSyncOptions): RuntimeDataSync {
	const views = new Map<string, ViewTarget>();
	let dataKeys = new Set(Object.keys(options.data));
	let version = 0;

	const apply = () => {
		const data = readNotebookData(model);
		if (hasRemovedKeys(dataKeys, data)) {
			onReset();
			return;
		}
		options.data = data;
		dataKeys = new Set(Object.keys(data));
		version += 1;
		applyRuntimeData(runtime, data, views, viewNames, signal, () => version);
	};
	model.on("change:_data", apply);
	signal.addEventListener("abort", () => model.off("change:_data", apply), { once: true });

	return {
		apply,
		setView(name, view) {
			views.set(name, view);
			const data = readNotebookData(model);
			if (Object.prototype.hasOwnProperty.call(data, name)) {
				void writeDataValueToView(name, view, data[name], views, signal, () => version);
			}
		},
		deleteView(name, view) {
			if (views.get(name) === view) views.delete(name);
		},
	};
}

export function readNotebookData(model: RenderProps<WidgetModel>["model"]): Record<string, unknown> {
	const value = model.get("_data");
	return value === null || typeof value !== "object" || Array.isArray(value) ? {} : value;
}

function hasRemovedKeys(previous: Set<string>, next: Record<string, unknown>): boolean {
	for (const name of previous) {
		if (!Object.prototype.hasOwnProperty.call(next, name)) return true;
	}
	return false;
}

function applyRuntimeData(
	runtime: NotebookRuntime,
	data: Record<string, unknown>,
	views: Map<string, ViewTarget>,
	viewNames: Set<string>,
	signal: AbortSignal,
	readVersion: () => number,
): void {
	const definitions: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(data)) {
		const view = views.get(name);
		if (view) {
			void writeDataValueToView(name, view, value, views, signal, readVersion);
		} else if (viewNames.has(name)) {
			continue;
		} else {
			definitions[name] = value;
		}
	}
	setRuntimeData(runtime, definitions);
}

async function writeDataValueToView(
	name: string,
	view: ViewTarget,
	wireValue: unknown,
	views: Map<string, ViewTarget>,
	signal: AbortSignal,
	readVersion: () => number,
): Promise<void> {
	const version = readVersion();
	const value = await revivePythonValue(wireValue);
	if (signal.aborted || version !== readVersion() || views.get(name) !== view) return;
	if (sameWireValue(toWireValue(readViewValue(view)), toWireValue(value))) return;
	writeViewValue(view, value);
}
