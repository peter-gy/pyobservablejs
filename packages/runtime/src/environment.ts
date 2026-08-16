import { NotebookRuntime, library } from "@observablehq/notebook-kit/runtime";
import type { RuntimeLibrary } from "@observablehq/runtime";
import { Library } from "@observablehq/stdlib";
import {
	createDuckDBClient,
	createFileAttachment,
	extendRuntimeFileAttachments,
	loadSQLiteModule,
	SQLiteDatabaseClient,
	type AttachmentInfo,
	type AttachmentRegistry,
} from "./attachments";
import { bindRuntimeScope, cleanupRuntimeScope, createRuntimeScope, createScopedGenerators } from "./scope";
import { createVariableBuiltins, type WireValues } from "./values";
import { isCallable } from "./value-kind";

export type RuntimeProfile = "notebook-kit" | "observable";

export type RuntimeOptions = {
	attachments: Record<string, AttachmentInfo>;
	baseUrl: string;
	variables: WireValues;
	runtimeProfile?: RuntimeProfile;
};

export type NotebookOptions = RuntimeOptions & {
	showSource: boolean;
};

type NotebookRuntimeBuiltins = NonNullable<ConstructorParameters<typeof NotebookRuntime>[0]>;
const RUNTIME_CORE_NAMES = ["@variable", "invalidation", "visibility"] as const;
const builtinNamesByRuntime = new WeakMap<NotebookRuntime, ReadonlySet<string>>();

export function createRuntime(
	root: HTMLElement,
	el: HTMLElement,
	options: RuntimeOptions,
	attachmentRegistry: AttachmentRegistry,
): NotebookRuntime {
	const width = () => observeWidth(root, el);
	const scope = createRuntimeScope(root);
	const scopedGenerators = createScopedGenerators(root);
	const builtins = {
		...selectRuntimeLibrary(options.runtimeProfile),
		DuckDBClient: () =>
			Promise.resolve(library.DuckDBClient()).then((DuckDBClient) =>
				createDuckDBClient(DuckDBClient, attachmentRegistry),
			),
		FileAttachment: () => createFileAttachment(options.baseUrl, attachmentRegistry),
		SQLite: () => loadSQLiteModule(),
		SQLiteDatabaseClient: () => SQLiteDatabaseClient,
		document: () => scope.document,
		width,
		dark: () => scopedGenerators.dark(),
	} satisfies RuntimeLibrary;
	if (options.runtimeProfile !== "observable") Object.assign(builtins, { Generators: () => scopedGenerators });
	const builtinNames = new Set([...RUNTIME_CORE_NAMES, ...Object.keys(builtins)]);
	assertNoBuiltinCollisions(options.variables, builtinNames);
	const runtime = new NotebookRuntime(
		toNotebookRuntimeBuiltins({
			...builtins,
			...createVariableBuiltins(options.variables),
		}),
	);
	builtinNamesByRuntime.set(runtime, builtinNames);
	extendRuntimeFileAttachments(runtime);
	bindRuntimeScope(runtime, scope);
	return runtime;
}

export function assertNoRuntimeBuiltinCollisions(runtime: NotebookRuntime, variables: WireValues): void {
	const builtinNames = builtinNamesByRuntime.get(runtime);
	if (!builtinNames) throw new Error("Runtime builtin metadata is unavailable");
	assertNoBuiltinCollisions(variables, builtinNames);
}

function selectRuntimeLibrary(profile: RuntimeProfile = "notebook-kit"): RuntimeLibrary {
	return profile === "observable" ? Object.assign({}, library, new Library()) : library;
}

function toNotebookRuntimeBuiltins(builtins: RuntimeLibrary): NotebookRuntimeBuiltins {
	// SAFETY: NotebookRuntime forwards builtins to Observable Runtime, which accepts definitions and constant values.
	return builtins as NotebookRuntimeBuiltins;
}

function assertNoBuiltinCollisions(variables: WireValues, builtinNames: ReadonlySet<string>): void {
	const collisions = Object.keys(variables)
		.filter((name) => builtinNames.has(name))
		.sort();
	if (collisions.length > 0) {
		throw new Error(`Python variables cannot override Observable runtime builtins: ${collisions.join(", ")}`);
	}
}

function observeWidth(root: HTMLElement, fallback: HTMLElement) {
	return library.Generators().observe((notify) => {
		let width: number | undefined;
		const update = (value = currentWidth(root, fallback)) => {
			const next = Math.max(320, Math.floor(value || 928));
			if (next !== width) notify((width = next));
		};
		update();
		if (!isCallable(globalThis.ResizeObserver)) return undefined;
		const observer = new ResizeObserver(([entry]) => update(entry?.contentRect.width));
		observer.observe(root);
		return () => observer.disconnect();
	});
}

function currentWidth(root: HTMLElement, fallback: HTMLElement): number {
	return root.getBoundingClientRect().width || fallback.clientWidth || 928;
}

export function setRuntimeVariables(runtime: NotebookRuntime, variables: WireValues): void {
	const definitions = createVariableBuiltins(variables);
	for (const [name, define] of Object.entries(definitions)) {
		try {
			runtime.main.redefine(name, [], define);
		} catch (cause) {
			if (!isUnknownRuntimeVariable(cause, name)) throw cause;
			runtime.main.define(name, [], define);
		}
	}
}

function isUnknownRuntimeVariable(cause: unknown, name: string): boolean {
	return cause instanceof Error && cause.message === `${name} is not defined`;
}

export function createRuntimeCleanup(runtime: NotebookRuntime, attachmentRegistry: AttachmentRegistry): () => void {
	let disposed = false;
	return () => {
		if (disposed) return;
		disposed = true;
		cleanupRuntimeScope(runtime);
		runtime.runtime.dispose();
		attachmentRegistry.cleanup();
	};
}
