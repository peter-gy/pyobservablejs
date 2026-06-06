import { NotebookRuntime, library } from "@observablehq/notebook-kit/runtime";
import { createFileAttachment } from "./attachments";
import type { AttachmentRegistry, NotebookOptions } from "./types";
import { createVariableBuiltins } from "./wire";

type RuntimeBuiltins = NonNullable<ConstructorParameters<typeof NotebookRuntime>[0]>;
type RuntimeBuiltinsWithVars = RuntimeBuiltins & Record<string, () => unknown>;

export function createRuntime(
	root: HTMLElement,
	el: HTMLElement,
	options: NotebookOptions,
	attachmentRegistry: AttachmentRegistry,
): NotebookRuntime {
	// Python variables enter OJS as Observable builtins before Notebook Kit defines cells.
	const width = () => observeWidth(root, el);
	const builtins = {
		...library,
		FileAttachment: () => createFileAttachment(options.baseUrl, attachmentRegistry),
		width: width as RuntimeBuiltins["width"],
		...createVariableBuiltins(options.variables),
	} as RuntimeBuiltinsWithVars;
	return new NotebookRuntime(builtins);
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
		runtime.runtime.dispose();
		attachmentRegistry.cleanup();
	};
}
