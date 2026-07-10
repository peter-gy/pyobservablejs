import type { NotebookRuntime } from "@observablehq/notebook-kit/runtime";
import { registerAttachments, type AttachmentRegistry } from "./attachments";
import { createRuntime, createRuntimeCleanup, type RuntimeOptions } from "./environment";

export type RuntimeSession = {
	runtime: NotebookRuntime;
	attachments: AttachmentRegistry;
	dispose(): void;
};

export function createRuntimeSession(root: HTMLElement, host: HTMLElement, options: RuntimeOptions): RuntimeSession {
	const attachments = registerAttachments(options.attachments);
	try {
		const runtime = createRuntime(root, host, options, attachments);
		return {
			runtime,
			attachments,
			dispose: createRuntimeCleanup(runtime, attachments),
		};
	} catch (error) {
		attachments.cleanup();
		throw error;
	}
}
