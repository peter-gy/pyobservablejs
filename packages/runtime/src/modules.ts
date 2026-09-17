import type { NotebookRuntime } from "@observablehq/notebook-kit/runtime";
import type { ModuleDefinition } from "@observablehq/runtime";
import { resolveNotebookReference, type ImportModule } from "./import-code";
import { bindRuntimeImporter } from "./module-context";
import { createNotebookModule, type LoadedNotebook } from "./module-definition";
import { normalizeNotebook, type NotebookOrigin, type ResolveNotebook } from "./source";

export function connectNotebookImports(
	runtime: NotebookRuntime,
	root: HTMLElement,
	resolve: ResolveNotebook | undefined,
	origin: NotebookOrigin = {},
): () => void {
	const lifetime = new AbortController();
	const sources = new Map<string, Promise<LoadedNotebook>>();
	const definitions = new Map<string, ModuleDefinition>();
	const cleanups: (() => void)[] = [];
	const loader =
		(parent: NotebookOrigin): ImportModule =>
		async (requested) => {
			lifetime.signal.throwIfAborted();
			if (!resolve) throw new Error(`Notebook import ${requested} requires a resolveNotebook source loader`);
			const reference = resolveNotebookReference(requested, parent);
			let pending = sources.get(reference);
			if (!pending) {
				pending = resolve(reference, { signal: lifetime.signal }).then((record) => ({
					...normalizeNotebook(record.source, {
						runtimeProfile: "runtimeProfile" in record ? record.runtimeProfile : undefined,
						origin: "origin" in record ? record.origin : undefined,
					}),
					attachments: record.attachments,
					baseUrl: record.baseUrl,
				}));
				sources.set(reference, pending);
				pending.catch(() => {
					if (sources.get(reference) === pending) sources.delete(reference);
				});
			}
			const record = await pending;
			lifetime.signal.throwIfAborted();
			const resolutions = { ...parent.resolutions, ...record.origin?.resolutions };
			const context = { ...record.origin, resolutions };
			const key = JSON.stringify([
				context.id ?? reference,
				context.version,
				record.runtimeProfile,
				Object.entries(resolutions).sort(([a], [b]) => a.localeCompare(b)),
			]);
			let define = definitions.get(key);
			if (!define) {
				define = createNotebookModule(root, record, loader(context), lifetime.signal, cleanups);
				definitions.set(key, define);
			}
			return { default: define };
		};
	bindRuntimeImporter(runtime, loader(origin));
	return () => {
		lifetime.abort();
		bindRuntimeImporter(runtime, undefined);
		for (const cleanup of cleanups) cleanup();
		cleanups.length = 0;
		sources.clear();
		definitions.clear();
	};
}
