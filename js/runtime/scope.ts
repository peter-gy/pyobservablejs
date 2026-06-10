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
	const customProperties = new Map<PropertyKey, unknown>();
	const scoped = new Proxy(document, {
		get(target, property) {
			if (customProperties.has(property)) return customProperties.get(property);
			if (property === "querySelector") return (selectors: string) => scopedQuerySelector(root, selectors);
			if (property === "querySelectorAll") return (selectors: string) => scopedQuerySelectorAll(root, selectors);
			if (property === "getElementById") return (id: string) => scopedGetElementById(root, id);
			if (property === "getElementsByClassName") {
				return (classNames: string) => scopedGetElementsByClassName(root, classNames);
			}
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
		set(target, property, value) {
			if (!(property in target)) {
				customProperties.set(property, value);
				return true;
			}
			return Reflect.set(target, property, value, target);
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

function scopedGetElementsByClassName(root: HTMLElement, classNames: string): HTMLCollectionOf<Element> {
	const rootMatches = matchesClassNames(root, classNames) ? [root] : [];
	return htmlCollectionLike([...rootMatches, ...root.getElementsByClassName(classNames)]);
}

function matchesClassNames(element: Element, classNames: string): boolean {
	const names = classNames.trim().split(/\s+/).filter(Boolean);
	return names.length > 0 && names.every((name) => element.classList.contains(name));
}

function nodeListLike(elements: Element[]): NodeListOf<Element> {
	return Object.assign(elements, {
		item: (index: number) => elements[index] ?? null,
	}) as unknown as NodeListOf<Element>;
}

function htmlCollectionLike(elements: Element[]): HTMLCollectionOf<Element> {
	return Object.assign(elements, {
		item: (index: number) => elements[index] ?? null,
		namedItem: (name: string) =>
			elements.find((element) => element.id === name || element.getAttribute("name") === name) ?? null,
	}) as unknown as HTMLCollectionOf<Element>;
}
