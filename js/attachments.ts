import { FileAttachment, registerFile } from "@observablehq/notebook-kit/runtime";
import type { AttachmentInfo, AttachmentRegistry } from "./types";

export function createFileAttachment(baseUrl: string, registry: AttachmentRegistry): typeof FileAttachment {
	// A synthetic base URL scopes registered attachments to this widget instance.
	const attachment = ((name: string, base?: string) => {
		const key = String(name);
		if (base !== undefined) return FileAttachment(key, base);
		const registered = registry.names.has(key) ? key : registry.names.has(decodeURI(key)) ? decodeURI(key) : null;
		return FileAttachment(registered ?? key, registered ? registry.baseUrl : baseUrl || document.baseURI);
	}) as typeof FileAttachment;
	attachment.prototype = FileAttachment.prototype;
	return attachment;
}

export function registerAttachments(attachments: Record<string, AttachmentInfo>): AttachmentRegistry {
	// registerFile mutates Notebook Kit's global registry; cleanup removes this base.
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
	return new URL(`.observablejs/${id}/`, document.baseURI).href;
}
