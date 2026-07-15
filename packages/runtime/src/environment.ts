import { NotebookRuntime, library } from "@observablehq/notebook-kit/runtime";
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
import { createVariableBuiltins } from "./values";

export type RuntimeProfile = "notebook-kit" | "observable";

export type RuntimeOptions = {
	attachments: Record<string, AttachmentInfo>;
	baseUrl: string;
	variables: Record<string, unknown>;
	runtimeProfile?: RuntimeProfile;
};

export type NotebookOptions = RuntimeOptions & {
	showSource: boolean;
};

type RuntimeBuiltins = NonNullable<ConstructorParameters<typeof NotebookRuntime>[0]>;
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
			Promise.resolve((library.DuckDBClient as () => unknown)()).then((DuckDBClient) =>
				createDuckDBClient(DuckDBClient as object, attachmentRegistry),
			),
		FileAttachment: () => createFileAttachment(options.baseUrl, attachmentRegistry),
		SQLite: () => loadSQLiteModule(),
		SQLiteDatabaseClient: () => SQLiteDatabaseClient,
		document: () => scope.document,
		width: width as RuntimeBuiltins["width"],
		dark: () => scopedGenerators.dark(),
		...(options.runtimeProfile === "observable" ? {} : { Generators: () => scopedGenerators }),
	};
	const builtinNames = new Set([...RUNTIME_CORE_NAMES, ...Object.keys(builtins)]);
	assertNoBuiltinCollisions(options.variables, builtinNames);
	// Observable Runtime accepts namespace objects as constants, while Notebook
	// Kit narrows its constructor type to builtin factories.
	const runtime = new NotebookRuntime({
		...builtins,
		...createVariableBuiltins(options.variables),
	} as RuntimeBuiltins);
	builtinNamesByRuntime.set(runtime, builtinNames);
	extendRuntimeFileAttachments(runtime);
	bindRuntimeScope(runtime, scope);
	return runtime;
}

export function assertNoRuntimeBuiltinCollisions(runtime: NotebookRuntime, variables: Record<string, unknown>): void {
	const builtinNames = builtinNamesByRuntime.get(runtime);
	if (!builtinNames) throw new Error("Runtime builtin metadata is unavailable");
	assertNoBuiltinCollisions(variables, builtinNames);
}

function selectRuntimeLibrary(profile: RuntimeProfile = "notebook-kit"): Record<string, unknown> {
	return profile === "observable" ? Object.assign({}, library, new Library()) : library;
}

function assertNoBuiltinCollisions(variables: Record<string, unknown>, builtinNames: ReadonlySet<string>): void {
	const collisions = Object.keys(variables)
		.filter((name) => builtinNames.has(name))
		.sort();
	if (collisions.length > 0) {
		throw new Error(`Python variables cannot override Observable runtime builtins: ${collisions.join(", ")}`);
	}
}

function observeWidth(root: HTMLElement, fallback: HTMLElement): AsyncGenerator<number, void, unknown> {
	return library.Generators().observe((notify) => {
		let width: number | undefined;
		const update = (value = currentWidth(root, fallback)) => {
			const next = Math.max(320, Math.floor(value || 928));
			if (next !== width) notify((width = next));
		};
		update();
		if (typeof ResizeObserver === "undefined") return undefined;
		const observer = new ResizeObserver(([entry]) => update(entry?.contentRect.width));
		observer.observe(root);
		return () => observer.disconnect();
	});
}

function currentWidth(root: HTMLElement, fallback: HTMLElement): number {
	return root.getBoundingClientRect().width || fallback.clientWidth || 928;
}

type RedefinableModule = {
	define(name: string, inputs: string[], definition: () => unknown): unknown;
	redefine(name: string, inputs: string[], definition: () => unknown): unknown;
};

export function setRuntimeVariables(runtime: NotebookRuntime, variables: Record<string, unknown>): void {
	const definitions = createVariableBuiltins(variables);
	for (const [name, define] of Object.entries(definitions)) {
		try {
			(runtime.main as RedefinableModule).redefine(name, [], define);
		} catch (error) {
			if (!isUnknownRuntimeVariable(error, name)) throw error;
			(runtime.main as RedefinableModule).define(name, [], define);
		}
	}
}

function isUnknownRuntimeVariable(error: unknown, name: string): boolean {
	return error instanceof Error && error.message === `${name} is not defined`;
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
