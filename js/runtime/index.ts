import { transpile, type Cell } from "@observablehq/notebook-kit";
import { FileAttachment, NotebookRuntime, library, registerFile } from "@observablehq/notebook-kit/runtime";
import { exposedVariableNames, unprefix } from "../notebook/graph";
import { bindRuntimeScope, cleanupRuntimeScope, createRuntimeScope } from "./scope";
import { createVariableBuiltins } from "./values";

export type AttachmentInfo = {
	url: string;
	mimeType?: string;
	lastModified?: number;
	size?: number;
};

export type NotebookOptions = {
	attachments: Record<string, AttachmentInfo>;
	baseUrl: string;
	variables: Record<string, unknown>;
	showSource: boolean;
};

export type AttachmentRegistry = {
	baseUrl: string;
	names: Set<string>;
	cleanup(): void;
};

export type { NestedSelectState, RuntimeVariablesSync, ViewTarget } from "./values";
export { runtimeDocument } from "./scope";
export {
	createVariableBuiltins,
	isViewTarget,
	readNestedSelectState,
	readViewValue,
	revivePythonValue,
	reviveSyncedValue,
	sameWireValue,
	toWireValue,
	writeViewValue,
} from "./values";

type RuntimeBuiltins = NonNullable<ConstructorParameters<typeof NotebookRuntime>[0]>;
type RuntimeBuiltinsWithVars = RuntimeBuiltins & Record<string, () => unknown>;
export type RuntimeGlobals = {
	document?: Document;
};

export function createRuntime(
	root: HTMLElement,
	el: HTMLElement,
	options: NotebookOptions,
	attachmentRegistry: AttachmentRegistry,
): NotebookRuntime {
	// Python variables enter OJS as Observable builtins before Notebook Kit defines cells.
	const width = () => observeWidth(root, el);
	const scope = createRuntimeScope(root);
	const builtins = {
		...library,
		FileAttachment: () => createFileAttachment(options.baseUrl, attachmentRegistry),
		document: () => scope.document,
		width: width as RuntimeBuiltins["width"],
		...createVariableBuiltins(options.variables),
	} as RuntimeBuiltinsWithVars;
	const runtime = new NotebookRuntime(builtins);
	bindRuntimeScope(runtime, scope);
	return runtime;
}

function observeWidth(root: HTMLElement, fallback: HTMLElement): AsyncGenerator<number, void, unknown> {
	return observe((notify) => {
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

function observe<T>(
	initialize: (notify: (value: T) => T) => (() => void) | undefined,
): AsyncGenerator<T, void, unknown> {
	let resolve: ((value: T) => void) | undefined;
	let reject: ((error: unknown) => void) | undefined;
	let value: T;
	let stale = false;
	const dispose = initialize((next) => {
		value = next;
		if (resolve) {
			resolve(next);
			resolve = undefined;
			reject = undefined;
		} else {
			stale = true;
		}
		return next;
	});
	return {
		async next() {
			return {
				done: false,
				value: await (stale
					? ((stale = false), value)
					: new Promise<T>((res, rej) => {
							resolve = res;
							reject = rej;
						})),
			};
		},
		async return() {
			reject?.(new Error("Generator returned"));
			resolve = undefined;
			reject = undefined;
			dispose?.();
			return { done: true, value: undefined };
		},
		async throw(error) {
			reject?.(error);
			resolve = undefined;
			reject = undefined;
			dispose?.();
			return { done: true, value: undefined };
		},
		[Symbol.asyncIterator]() {
			return this;
		},
	};
}

function currentWidth(root: HTMLElement, fallback: HTMLElement): number {
	return root.getBoundingClientRect().width || fallback.clientWidth || 928;
}

type RedefinableModule = NotebookRuntime["main"] & {
	define(name: string, inputs: string[], definition: () => unknown): unknown;
	redefine(name: string, inputs: string[], definition: () => unknown): unknown;
};

export function redefineRuntimeVariables(runtime: NotebookRuntime, variables: Record<string, unknown>): void {
	const definitions = createVariableBuiltins(variables);
	for (const [name, define] of Object.entries(definitions)) {
		try {
			(runtime.main as RedefinableModule).redefine(name, [], define);
		} catch (error) {
			if (!isUnknownRuntimeVariable(error, name)) throw error;
		}
	}
}

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

export function createFileAttachment(baseUrl: string, registry: AttachmentRegistry): typeof FileAttachment {
	// A synthetic base URL scopes registered attachments to this widget instance.
	const attachment = ((name: string, base?: string) => {
		const key = String(name);
		if (base !== undefined) return FileAttachment(key, base);
		const decoded = safeDecodeURI(key);
		const registered = registry.names.has(key) ? key : decoded && registry.names.has(decoded) ? decoded : null;
		return FileAttachment(registered ?? key, registered ? registry.baseUrl : baseUrl || document.baseURI);
	}) as typeof FileAttachment;
	attachment.prototype = FileAttachment.prototype;
	return attachment;
}

function safeDecodeURI(value: string): string | null {
	try {
		return decodeURI(value);
	} catch {
		return null;
	}
}

export function registerAttachments(attachments: Record<string, AttachmentInfo>): AttachmentRegistry {
	// registerFile mutates Notebook Kit's global registry. Cleanup removes this base.
	const base = createAttachmentRegistryBase();
	const registered: string[] = [];
	for (const [name, info] of Object.entries(attachments)) {
		registerFile(
			name,
			{
				path: info.url,
				mimeType: info.mimeType,
				lastModified: info.lastModified,
				size: info.size,
			},
			base,
		);
		registered.push(name);
	}
	return {
		baseUrl: base,
		names: new Set(registered),
		cleanup() {
			for (const name of registered) registerFile(name, null, base);
		},
	};
}

function createAttachmentRegistryBase(): string {
	const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Math.random().toString(36).slice(2);
	return new URL(`.pyobservablejs/${id}/`, document.baseURI).href;
}

type RuntimeDefinition = Parameters<NotebookRuntime["define"]>[1];
type RuntimeBody = RuntimeDefinition["body"];
type TranspiledDefinition = ReturnType<typeof transpile>;

const TEMPLATE_MODES = new Set<Cell["mode"]>(["dot", "html", "md", "sql", "tex"]);

export function createRuntimeDefinition(
	cell: Cell,
	definition: TranspiledDefinition,
	globals: RuntimeGlobals = {},
): RuntimeDefinition {
	const body = compileRuntimeBody(definition.body, globals);
	return {
		id: cell.id,
		body: TEMPLATE_MODES.has(cell.mode) ? awaitTemplateInputs(body) : body,
		inputs: definition.inputs,
		outputs: definition.outputs,
		output: definition.output,
		autodisplay: definition.autodisplay,
		autoview: definition.autoview,
		automutable: definition.automutable,
	};
}

function compileRuntimeBody(source: string, globals: RuntimeGlobals): RuntimeBody {
	const entries = Object.entries(globals).filter((entry) => entry[1] !== undefined) as [string, unknown][];
	const names = entries.map(([name]) => name);
	const values = entries.map(([, value]) => value);
	return new Function(...names, `"use strict"; return (${source});`)(...values) as RuntimeBody;
}

function awaitTemplateInputs(body: RuntimeBody): RuntimeBody {
	return async function (this: unknown, ...values: unknown[]) {
		return body.call(this, ...(await Promise.all(values)));
	} as RuntimeBody;
}

export function runtimeDefinitionNames(definition: RuntimeDefinition): string[] {
	const names = new Set<string>();
	if (definition.output) {
		names.add(definition.output);
		if (definition.autoview) names.add(unprefix(definition.output, "viewof$"));
		if (definition.automutable) {
			const name = unprefix(definition.output, "mutable ");
			names.add(name);
			names.add(`mutable$${name}`);
		}
	} else {
		for (const name of definition.outputs ?? []) names.add(name);
	}
	return Array.from(names);
}

export function runtimeVariableNames(definition: TranspiledDefinition): string[] {
	const names = new Set(exposedVariableNames(definition));
	if (definition.output) {
		names.add(definition.output);
		if (definition.automutable) names.add(`mutable$${unprefix(definition.output, "mutable ")}`);
	} else {
		for (const name of definition.outputs ?? []) names.add(name);
	}
	return Array.from(names);
}
