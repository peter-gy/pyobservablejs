import { deserialize, toNotebook, type Notebook, type NotebookSpec } from "@observablehq/notebook-kit";
import type { AttachmentInfo } from "./attachment-info";
import { isNumber, isObjectValue, isString } from "./value-kind";

export type RuntimeProfile = "notebook-kit" | "observable";

export type NotebookOrigin = {
	id?: string | null;
	version?: number | null;
	format?: "classic" | "notebook-kit";
	resolutions?: Readonly<Record<string, string>>;
};

export type NotebookSource = {
	source: string | NotebookSpec;
	origin?: NotebookOrigin;
	runtimeProfile?: RuntimeProfile;
	attachments?: Record<string, AttachmentInfo>;
	baseUrl?: string;
};

export type ResolveNotebook = (specifier: string, options: { signal: AbortSignal }) => Promise<NotebookSource>;

export type NormalizedNotebook = {
	notebook: Notebook;
	runtimeProfile: RuntimeProfile;
	origin?: NotebookOrigin;
};

type SourceOptions = { runtimeProfile?: RuntimeProfile; origin?: NotebookOrigin };

export function normalizeNotebook(source: string | NotebookSpec, options: SourceOptions = {}): NormalizedNotebook {
	if (!isString(source))
		return {
			notebook: toNotebook(source),
			runtimeProfile: options.runtimeProfile ?? "notebook-kit",
			origin: options.origin,
		};
	const document = new DOMParser().parseFromString(source, "text/html");
	const root = document.querySelector("notebook");
	const profile = root?.getAttribute("data-pyobservablejs-runtime-profile") ?? options.runtimeProfile ?? "notebook-kit";
	if (profile !== "observable" && profile !== "notebook-kit")
		throw new Error(`Unknown notebook runtime profile: ${profile}`);
	const encodedOrigin = root?.getAttribute("data-pyobservablejs-origin");
	const origin = encodedOrigin ? parseNotebookOrigin(JSON.parse(encodedOrigin)) : options.origin;
	return {
		notebook: deserialize(source, { parser: { parseFromString: () => document } }),
		runtimeProfile: profile,
		origin,
	};
}

export function parseNotebookOrigin<Value>(value: Value): NotebookOrigin {
	if (!isObjectValue(value) || Array.isArray(value)) throw new Error("Notebook origin must be an object");
	const id = "id" in value ? value.id : undefined;
	const version = "version" in value ? value.version : undefined;
	const format = "format" in value ? value.format : undefined;
	if (id != null && !isString(id)) throw new Error("Notebook origin id must be a string");
	if (version != null && (!isNumber(version) || !Number.isSafeInteger(version) || version < 0))
		throw new Error("Notebook origin version must be a nonnegative integer");
	if (format !== undefined && format !== "classic" && format !== "notebook-kit")
		throw new Error("Unknown notebook source format");
	const resolutions: Record<string, string> = {};
	if ("resolutions" in value) {
		if (!isObjectValue(value.resolutions) || Array.isArray(value.resolutions))
			throw new Error("Notebook resolutions must be an object");
		for (const [name, resolution] of Object.entries(value.resolutions)) {
			if (!isString(resolution)) throw new Error("Notebook resolution must be a string");
			Object.defineProperty(resolutions, name, { value: resolution, enumerable: true });
		}
	}
	return { id, version, format, resolutions };
}
