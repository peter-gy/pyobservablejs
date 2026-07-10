import { library, type NotebookRuntime } from "@observablehq/notebook-kit/runtime";

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

type RuntimeGenerators = ReturnType<(typeof library)["Generators"]>;

export function createScopedGenerators(root: HTMLElement): RuntimeGenerators {
	const generators = library.Generators();
	return {
		...generators,
		dark: () => observeDark(root, generators),
	};
}

function observeDark(root: HTMLElement, generators: RuntimeGenerators): ReturnType<RuntimeGenerators["dark"]> {
	return generators.observe<boolean>((notify) => {
		let dark: boolean | undefined;
		const view = root.ownerDocument.defaultView;
		if (!view) throw new Error("Notebook root must belong to a window");
		const media = view.matchMedia("(prefers-color-scheme: dark)");
		const probe = root.ownerDocument.createElement("div");
		probe.style.transitionProperty = "color, background-color";
		probe.style.transitionDuration = "1ms";
		const changed = () => {
			const schemes = view.getComputedStyle(root).getPropertyValue("color-scheme").split(/\s+/);
			const next = schemes.includes("light") && schemes.includes("dark") ? media.matches : schemes.includes("dark");
			if (dark === next) return;
			notify((dark = next));
		};
		root.appendChild(probe);
		changed();
		probe.addEventListener("transitionstart", changed);
		media.addEventListener("change", changed);
		return () => {
			probe.remove();
			media.removeEventListener("change", changed);
		};
	});
}

function createScopedDocument(root: HTMLElement): Document {
	const customProperties = new Map<PropertyKey, unknown>();
	const ownerDocument = root.ownerDocument;
	const scoped = new Proxy(ownerDocument, {
		get(target, property) {
			if (customProperties.has(property)) return customProperties.get(property);
			if (property === "querySelector") return (selectors: string) => scopedQuerySelector(root, selectors);
			if (property === "querySelectorAll") return (selectors: string) => scopedQuerySelectorAll(root, selectors);
			if (property === "getElementById") return (id: string) => scopedGetElementById(root, id);
			if (property === "getElementsByClassName") {
				return (classNames: string) => scopedGetElementsByClassName(root, classNames);
			}
			if (property === "getElementsByTagName") return (name: string) => scopedGetElementsByTagName(root, name);
			if (property === "getElementsByTagNameNS") {
				return (namespace: string | null, name: string) => scopedGetElementsByTagNameNS(root, namespace, name);
			}
			if (property === "getElementsByName") return (name: string) => scopedGetElementsByName(root, name);
			if (property === "forms") return scopedCollection(root, "form");
			if (property === "images") return scopedCollection(root, "img");
			if (property === "links") return scopedCollection(root, "a[href], area[href]");
			if (property === "activeElement") return scopedActiveElement(root);
			if (property === "body" || property === "head" || property === "documentElement") return root;
			if (property === "addEventListener") return root.addEventListener.bind(root);
			if (property === "removeEventListener") return root.removeEventListener.bind(root);
			if (property === "dispatchEvent") return root.dispatchEvent.bind(root);
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
		set(_target, property, value) {
			customProperties.set(property, value);
			return true;
		},
	});
	return scoped as Document;
}

function scopedActiveElement(root: HTMLElement): Element | null {
	const treeRoot = root.getRootNode();
	const active =
		"activeElement" in treeRoot ? (treeRoot as Document | ShadowRoot).activeElement : root.ownerDocument.activeElement;
	return active && (active === root || root.contains(active)) ? active : null;
}

function scopedQuerySelector(root: HTMLElement, selectors: string): Element | null {
	if (root.matches(selectors)) return root;
	return root.querySelector(selectors);
}

function scopedQuerySelectorAll(root: HTMLElement, selectors: string): NodeListOf<Element> {
	const matches = [...(root.matches(selectors) ? [root] : []), ...root.querySelectorAll(selectors)];
	return nodeListLike(() => matches);
}

function scopedGetElementById(root: HTMLElement, id: string): Element | null {
	if (root.id === id) return root;
	for (const element of root.querySelectorAll("[id]")) {
		if (element.id === id) return element;
	}
	return null;
}

function scopedGetElementsByClassName(root: HTMLElement, classNames: string): HTMLCollectionOf<Element> {
	return htmlCollectionLike(() => {
		const rootMatches = matchesClassNames(root, classNames) ? [root] : [];
		return [...rootMatches, ...root.getElementsByClassName(classNames)];
	});
}

function scopedGetElementsByTagName(root: HTMLElement, name: string): HTMLCollectionOf<Element> {
	const normalized = name.toLowerCase();
	return htmlCollectionLike(() =>
		scopedElements(root).filter((element) => normalized === "*" || element.localName === normalized),
	);
}

function scopedGetElementsByTagNameNS(
	root: HTMLElement,
	namespace: string | null,
	name: string,
): HTMLCollectionOf<Element> {
	return htmlCollectionLike(() =>
		scopedElements(root).filter(
			(element) =>
				(namespace === "*" || element.namespaceURI === namespace) && (name === "*" || element.localName === name),
		),
	);
}

function scopedGetElementsByName(root: HTMLElement, name: string): NodeListOf<HTMLElement> {
	return nodeListLike(() =>
		scopedElements(root).filter((element): element is HTMLElement => element.getAttribute("name") === name),
	);
}

function scopedCollection(root: HTMLElement, selectors: string): HTMLCollectionOf<Element> {
	return htmlCollectionLike(() => scopedElements(root).filter((element) => element.matches(selectors)));
}

function scopedElements(root: HTMLElement): Element[] {
	return [root, ...root.querySelectorAll("*")];
}

function matchesClassNames(element: Element, classNames: string): boolean {
	const names = classNames.trim().split(/\s+/).filter(Boolean);
	return names.length > 0 && names.every((name) => element.classList.contains(name));
}

function nodeListLike<T extends Element>(resolve: () => T[]): NodeListOf<T> {
	let collection: NodeListOf<T>;
	collection = new Proxy(
		{},
		{
			get(_target, property) {
				if (property === "length") return resolve().length;
				if (property === "item") return (index: number) => resolve()[index] ?? null;
				if (property === "entries") return () => resolve().entries();
				if (property === "keys") return () => resolve().keys();
				if (property === "values" || property === Symbol.iterator) return () => resolve().values();
				if (property === "forEach") {
					return (callback: (value: T, index: number, list: NodeListOf<T>) => void, thisArg?: unknown) =>
						resolve().forEach((value, index) => callback.call(thisArg, value, index, collection));
				}
				if (property === Symbol.toStringTag) return "NodeList";
				const index = collectionIndex(property);
				return index === undefined ? undefined : resolve()[index];
			},
			has(_target, property) {
				const index = collectionIndex(property);
				return index === undefined
					? property === "length" || property === "item" || property === Symbol.iterator
					: index < resolve().length;
			},
		},
	) as NodeListOf<T>;
	return collection;
}

function htmlCollectionLike<T extends Element>(resolve: () => T[]): HTMLCollectionOf<T> {
	return new Proxy(
		{},
		{
			get(_target, property) {
				if (property === "length") return resolve().length;
				if (property === "item") return (index: number) => resolve()[index] ?? null;
				if (property === "namedItem") {
					return (name: string) =>
						name === ""
							? null
							: (resolve().find((element) => element.id === name || element.getAttribute("name") === name) ?? null);
				}
				if (property === Symbol.iterator) return () => resolve().values();
				if (property === Symbol.toStringTag) return "HTMLCollection";
				const index = collectionIndex(property);
				return index === undefined ? undefined : resolve()[index];
			},
			has(_target, property) {
				const index = collectionIndex(property);
				return index === undefined
					? property === "length" || property === "item" || property === "namedItem" || property === Symbol.iterator
					: index < resolve().length;
			},
		},
	) as HTMLCollectionOf<T>;
}

function collectionIndex(property: PropertyKey): number | undefined {
	if (typeof property !== "string" || !/^(0|[1-9]\d*)$/.test(property)) return undefined;
	const index = Number(property);
	return Number.isSafeInteger(index) ? index : undefined;
}
