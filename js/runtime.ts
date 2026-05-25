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
	const width = () => Math.max(320, Math.floor(root.getBoundingClientRect().width || el.clientWidth || 928));
	const builtins = {
		...library,
		FileAttachment: () => createFileAttachment(options.baseUrl, attachmentRegistry),
		width: width as RuntimeBuiltins["width"],
		...createVariableBuiltins(options.variables),
	} as RuntimeBuiltinsWithVars;
	return new NotebookRuntime(builtins);
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
