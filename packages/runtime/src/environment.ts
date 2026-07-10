import { NotebookRuntime, library } from "@observablehq/notebook-kit/runtime";
import {
	createDuckDBClient,
	createFileAttachment,
	extendRuntimeFileAttachments,
	loadSQLiteModule,
	SQLiteDatabaseClient,
	type AttachmentInfo,
	type AttachmentRegistry,
} from "./attachments";
import {
	createGenerators,
	createRuntimeCompatibilityBuiltins,
	runtimeCompatibilityBuiltinNames,
	type RuntimeCompatibilityOptions,
} from "./compat";
import { bindRuntimeScope, cleanupRuntimeScope, createRuntimeScope, createScopedGenerators } from "./scope";
import { createVariableBuiltins } from "./values";

export type RuntimeOptions = {
	attachments: Record<string, AttachmentInfo>;
	baseUrl: string;
	variables: Record<string, unknown>;
	runtimeCompatibility?: RuntimeCompatibilityOptions;
};

export type NotebookOptions = RuntimeOptions & {
	showSource: boolean;
};

type RuntimeBuiltins = NonNullable<ConstructorParameters<typeof NotebookRuntime>[0]>;
type RuntimeBuiltinsWithVars = RuntimeBuiltins & Record<string, () => unknown>;
const CORE_RUNTIME_NAMES = new Set([
	...Object.keys(library),
	"DuckDBClient",
	"FileAttachment",
	"SQLite",
	"SQLiteDatabaseClient",
	"document",
	"width",
]);

export function createRuntime(
	root: HTMLElement,
	el: HTMLElement,
	options: RuntimeOptions,
	attachmentRegistry: AttachmentRegistry,
): NotebookRuntime {
	// Python variables enter OJS as Observable builtins before Notebook Kit defines cells.
	const collisions = runtimeBuiltinCollisions(options.variables, options.runtimeCompatibility);
	if (collisions.length > 0)
		throw new Error(`Python variables cannot override Observable runtime builtins: ${collisions.join(", ")}`);
	const width = () => observeWidth(root, el);
	const scope = createRuntimeScope(root);
	const scopedGenerators = createScopedGenerators(root);
	const runtimeGenerators = options.runtimeCompatibility?.generators
		? createGenerators(scopedGenerators)
		: scopedGenerators;
	const builtins = {
		...library,
		DuckDBClient: () =>
			Promise.resolve((library.DuckDBClient as () => unknown)()).then((DuckDBClient) =>
				createDuckDBClient(DuckDBClient as object, attachmentRegistry),
			),
		FileAttachment: () => createFileAttachment(options.baseUrl, attachmentRegistry),
		SQLite: () => loadSQLiteModule(),
		SQLiteDatabaseClient: () => SQLiteDatabaseClient,
		document: () => scope.document,
		width: width as RuntimeBuiltins["width"],
		...createRuntimeCompatibilityBuiltins(options.runtimeCompatibility),
		dark: () => scopedGenerators.dark(),
		Generators: () => runtimeGenerators,
		...createVariableBuiltins(options.variables),
	} as RuntimeBuiltinsWithVars;
	const runtime = new NotebookRuntime(builtins);
	extendRuntimeFileAttachments(runtime);
	bindRuntimeScope(runtime, scope);
	return runtime;
}

function runtimeBuiltinCollisions(
	variables: Record<string, unknown>,
	compatibility: RuntimeCompatibilityOptions = {},
): string[] {
	const reserved = new Set([...CORE_RUNTIME_NAMES, ...runtimeCompatibilityBuiltinNames(compatibility)]);
	return Object.keys(variables)
		.filter((name) => reserved.has(name))
		.sort();
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
