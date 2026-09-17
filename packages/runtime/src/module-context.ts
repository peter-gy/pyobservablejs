import type { NotebookRuntime } from "@observablehq/notebook-kit/runtime";
import type { ImportModule } from "./import-code";

const importers = new WeakMap<NotebookRuntime, ImportModule>();

export function bindRuntimeImporter(runtime: NotebookRuntime, importer: ImportModule | undefined): void {
	if (importer) importers.set(runtime, importer);
	else importers.delete(runtime);
}

export function runtimeImporter(runtime: NotebookRuntime): ImportModule | undefined {
	return importers.get(runtime);
}
