import { connectNotebookImports } from "./modules";
import type { NotebookRuntime } from "@observablehq/notebook-kit/runtime";
import { registerAttachments, type AttachmentRegistry } from "./attachments";
import { createRuntime, createRuntimeCleanup, type RuntimeOptions } from "./environment";

export type RuntimeSession = {
	runtime: NotebookRuntime;
	attachments: AttachmentRegistry;
	dispose(): void;
};

export function createRuntimeSession(root: HTMLElement, options: RuntimeOptions): RuntimeSession {
	const attachments = registerAttachments(options.attachments);
	try {
		const runtime = createRuntime(root, options, attachments);
		const closeImports = connectNotebookImports(
			runtime,
			root,
			options.resolveNotebook,
			options.origin,
			options.headless,
		);
		const closeRuntime = createRuntimeCleanup(runtime, attachments);
		return {
			runtime,
			attachments,
			dispose() {
				// Resolve Runtime invalidation before releasing module attachment and scope resources.
				closeRuntime();
				closeImports();
			},
		};
	} catch (error) {
		attachments.cleanup();
		throw error;
	}
}
