import { NotebookRuntime, library } from "@observablehq/notebook-kit/runtime";
import { createFileAttachment } from "./attachments";
import type { AttachmentRegistry, NotebookOptions } from "./types";
import { createVariableBuiltins } from "./wire";

type RuntimeBuiltins = NonNullable<ConstructorParameters<typeof NotebookRuntime>[0]>;
type RuntimeBuiltinsWithVariables = RuntimeBuiltins & Record<string, () => unknown>;

export function createRuntime(
	root: HTMLElement,
	el: HTMLElement,
	options: NotebookOptions,
	attachmentRegistry: AttachmentRegistry,
): NotebookRuntime {
	// Python data enters OJS as Observable builtins before Notebook Kit defines cells.
	const width = () => Math.max(320, Math.floor(root.getBoundingClientRect().width || el.clientWidth || 928));
	const builtins = {
		...library,
		FileAttachment: () => createFileAttachment(options.baseUrl, attachmentRegistry),
		width: width as RuntimeBuiltins["width"],
		...createVariableBuiltins(options.data),
	} as RuntimeBuiltinsWithVariables;
	return new NotebookRuntime(builtins);
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
