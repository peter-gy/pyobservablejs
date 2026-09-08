import { NotebookRuntime, library } from "@observablehq/notebook-kit/runtime";
import type { RuntimeLibrary } from "@observablehq/runtime";
import { Library } from "@observablehq/stdlib";
import {
	createDuckDBClient,
	createFileAttachment,
	extendRuntimeFileAttachments,
	loadSQLiteModule,
	SQLiteDatabaseClient,
	type AttachmentRegistry,
} from "./attachments";
import type { AttachmentInfo } from "./attachment-info";
import { bindRuntimeScope, cleanupRuntimeScope, createRuntimeScope, createScopedGenerators } from "./scope";
import { createVariableBuiltins, type Variables } from "./values";

export type RuntimeProfile = "notebook-kit" | "observable";

export type RuntimeOptions = {
	attachments: Record<string, AttachmentInfo>;
	baseUrl: string;
	variables: Variables;
	runtimeProfile?: RuntimeProfile;
};

export type NotebookOptions = RuntimeOptions & {
	showSource: boolean;
};

type NotebookRuntimeBuiltins = NonNullable<ConstructorParameters<typeof NotebookRuntime>[0]>;
const RUNTIME_CORE_NAMES = ["@variable", "invalidation", "visibility"] as const;
const builtinNamesByRuntime = new WeakMap<NotebookRuntime, ReadonlySet<string>>();
const observableRequire = Symbol.for("@pyobservablejs/runtime/observable-require/v1");

export function createRuntime(
	root: HTMLElement,
	options: RuntimeOptions,
	attachmentRegistry: AttachmentRegistry,
): NotebookRuntime {
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
		width: () => library.Generators().width(root),
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

export function assertNoRuntimeBuiltinCollisions(runtime: NotebookRuntime, variables: Variables): void {
	const builtinNames = builtinNamesByRuntime.get(runtime);
	if (!builtinNames) throw new Error("Runtime builtin metadata is unavailable");
	assertNoBuiltinCollisions(variables, builtinNames);
}

function selectRuntimeLibrary(profile: RuntimeProfile = "notebook-kit"): RuntimeLibrary {
	if (profile !== "observable") return library;
	// d3-require pairs a global AMD callback with its module queue. Independently
	// loaded bundles must share that loader before creating classic libraries.
	// SAFETY: This versioned symbol stores the upstream loader across bundle instances.
	const realm = globalThis as typeof globalThis & { [observableRequire]?: typeof Library.require };
	Library.require = realm[observableRequire] ??= Library.require;
	return Object.assign({}, library, new Library());
}

function toNotebookRuntimeBuiltins(builtins: RuntimeLibrary): NotebookRuntimeBuiltins {
	// SAFETY: NotebookRuntime forwards builtins to Observable Runtime, which accepts definitions and constant values.
	return builtins as NotebookRuntimeBuiltins;
}

function assertNoBuiltinCollisions(variables: Variables, builtinNames: ReadonlySet<string>): void {
	const collisions = Object.keys(variables)
		.filter((name) => builtinNames.has(name))
		.sort();
	if (collisions.length > 0) {
		throw new Error(`Variables cannot override Observable runtime builtins: ${collisions.join(", ")}`);
	}
}

export function setRuntimeVariables(runtime: NotebookRuntime, variables: Variables): void {
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
