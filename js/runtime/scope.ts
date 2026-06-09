import type { NotebookRuntime } from "@observablehq/notebook-kit/runtime";

export type RuntimeGlobals = {
	document?: Document;
};

export type RuntimeScope = {
	document: Document;
	cleanup(): void;
};

const runtimeScopes = new WeakMap<NotebookRuntime, RuntimeScope>();

export function createRuntimeScope(root: HTMLElement): RuntimeScope {
	return {
		document: createScopedDocument(root),
		cleanup() {},
	};
}

export function bindRuntimeScope(runtime: NotebookRuntime, scope: RuntimeScope): void {
	runtimeScopes.set(runtime, scope);
}

export function runtimeDocument(runtime: NotebookRuntime): Document | undefined {
	return runtimeScopes.get(runtime)?.document;
}

export function cleanupRuntimeScope(runtime: NotebookRuntime): void {
	const scope = runtimeScopes.get(runtime);
	if (!scope) return;
	scope.cleanup();
	runtimeScopes.delete(runtime);
}

function createScopedDocument(root: HTMLElement): Document {
	const scoped = new Proxy(document, {
		get(target, property, receiver) {
			if (property === "querySelector") return (selectors: string) => scopedQuerySelector(root, selectors);
			if (property === "querySelectorAll") return (selectors: string) => scopedQuerySelectorAll(root, selectors);
			if (property === "getElementById") return (id: string) => scopedGetElementById(root, id);
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return scoped as Document;
}

function scopedQuerySelector(root: HTMLElement, selectors: string): Element | null {
	if (root.matches(selectors)) return root;
	return root.querySelector(selectors);
}

function scopedQuerySelectorAll(root: HTMLElement, selectors: string): NodeListOf<Element> {
	const matches = [...(root.matches(selectors) ? [root] : []), ...root.querySelectorAll(selectors)];
	return nodeListLike(matches);
}

function scopedGetElementById(root: HTMLElement, id: string): Element | null {
	if (root.id === id) return root;
	for (const element of root.querySelectorAll("[id]")) {
		if (element.id === id) return element;
	}
	return null;
}

function nodeListLike(elements: Element[]): NodeListOf<Element> {
	return Object.assign(elements, {
		item: (index: number) => elements[index] ?? null,
	}) as unknown as NodeListOf<Element>;
}
