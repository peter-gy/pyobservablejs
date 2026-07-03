import { library } from "@observablehq/notebook-kit/runtime";
import { unprefix, type RuntimeCellDefinition } from "./graph";
import { observe } from "./observe";

type HtmlTemplateTag = (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
type LegacyRequire = {
	(...specifiers: unknown[]): Promise<unknown>;
	resolve(specifier: unknown): string;
	alias(aliases: Record<string, string>): LegacyRequire;
};
type NpmSpecifier = {
	name: string;
	range: string;
	path: string;
};

const SAFE_HTML_INTERPOLATION_TAGS = new Set([
	"b",
	"br",
	"button",
	"code",
	"div",
	"em",
	"fieldset",
	"form",
	"i",
	"input",
	"label",
	"legend",
	"li",
	"ol",
	"option",
	"p",
	"select",
	"small",
	"span",
	"strong",
	"textarea",
	"ul",
]);
const URL_HTML_ATTRIBUTES = new Set(["action", "formaction", "href", "src", "srcdoc", "xlink:href"]);
const legacyRequireModuleCache = new WeakMap<object, unknown>();
const legacyRequire = Object.assign(createLegacyRequire(resolveLegacyRequire), { alias: legacyRequireAlias });
let htmlBuiltin: Promise<HtmlTemplateTag> | undefined;

const RUNTIME_COMPAT_BUILTINS = {
	Generators: () => createGenerators(library.Generators()),
	Mutable: () => ObservableMutable,
	html: () => loadHtmlBuiltin(),
	require: () => legacyRequire,
} satisfies Record<string, () => unknown>;

type RuntimeCompatibilityBuiltinName = keyof typeof RUNTIME_COMPAT_BUILTINS;

export const RUNTIME_COMPAT_BUILTIN_NAMES = Object.keys(RUNTIME_COMPAT_BUILTINS) as RuntimeCompatibilityBuiltinName[];

export function createRuntimeCompatibilityBuiltins(): Record<RuntimeCompatibilityBuiltinName, () => unknown> {
	return { ...RUNTIME_COMPAT_BUILTINS };
}

export function runtimeDefinitionCompatibility(
	definition: RuntimeCellDefinition,
	notebookNames: ReadonlySet<string> | undefined,
): { display?: false } {
	return usesNotebookDisplayName(definition, notebookNames) ? { display: false } : {};
}

function usesNotebookDisplayName(
	definition: RuntimeCellDefinition,
	notebookNames: ReadonlySet<string> | undefined,
): boolean {
	if (!notebookNames) return false;
	const ownNames = definitionNames(definition);
	return (definition.inputs ?? []).some(
		(name) => (name === "display" || name === "view") && notebookNames.has(name) && !ownNames.has(name),
	);
}

function definitionNames(definition: RuntimeCellDefinition): Set<string> {
	const names = new Set(definition.outputs ?? []);
	if (definition.output) {
		names.add(definition.output);
		if (definition.autoview) names.add(unprefix(definition.output, "viewof$"));
		if (definition.automutable) {
			const name = unprefix(definition.output, "mutable ");
			names.add(name);
			names.add(`mutable$${name}`);
		}
	}
	return names;
}

function createLegacyRequire(resolve: (specifier: unknown) => string): LegacyRequire {
	const require = (async (...specifiers: unknown[]) => {
		if (specifiers.length === 1) return import(/* @vite-ignore */ resolve(specifiers[0])).then(objectifyModule);
		return Promise.all(specifiers.map((specifier) => require(specifier))).then(mergeModules);
	}) as LegacyRequire;
	require.resolve = resolve;
	require.alias = legacyRequireAlias;
	return require;
}

function legacyRequireAlias(aliases: Record<string, string>): LegacyRequire {
	return createLegacyRequire((specifier) => resolveLegacyRequire(aliases[String(specifier)] ?? specifier));
}

function resolveLegacyRequire(specifier: unknown): string {
	const value = String(specifier);
	if (isProtocol(value) || isLocal(value)) return value;
	const { name, range, path } = parseNpmSpecifier(value);
	const suffix = (isFile(path) && !isJavaScript(path)) || isDirectory(path) ? "" : "/+esm";
	return `https://cdn.jsdelivr.net/npm/${name}${range}${path}${suffix}`;
}

function parseNpmSpecifier(specifier: string): NpmSpecifier {
	const parts = specifier.split("/");
	const namerange = specifier.startsWith("@") ? [parts.shift()!, parts.shift()!].join("/") : parts.shift()!;
	const ranged = namerange.indexOf("@", 1);
	const name = ranged > 0 ? namerange.slice(0, ranged) : namerange;
	const range = ranged > 0 ? namerange.slice(ranged) : "";
	const path = parts.length > 0 ? `/${parts.join("/")}` : "";
	return { name, range, path };
}

function objectifyModule(module: object): unknown {
	if (legacyRequireModuleCache.has(module)) return legacyRequireModuleCache.get(module);
	const object = defaultifyModule(module);
	legacyRequireModuleCache.set(module, object);
	return object;
}

function defaultifyModule(module: object): unknown {
	for (const key in module) if (key !== "default") return { ...module };
	return "default" in module ? module.default : { ...module };
}

function mergeModules(modules: unknown[]): unknown {
	return Object.assign({}, ...modules);
}

function isProtocol(specifier: string): boolean {
	return /^\w+:/.test(specifier);
}

function isLocal(specifier: string): boolean {
	return /^(\.\/|\.\.\/|\/)/.test(specifier);
}

function isJavaScript(specifier: string): boolean {
	return /\.js$/i.test(specifier);
}

function isFile(specifier: string): boolean {
	return /\.\w*$/.test(specifier);
}

function isDirectory(specifier: string): boolean {
	return specifier.endsWith("/");
}

function loadHtmlBuiltin(): Promise<HtmlTemplateTag> {
	return (htmlBuiltin ??= Promise.resolve((library.html as () => unknown)()).then((html) =>
		createObservableHtml(html as HtmlTemplateTag),
	));
}

export function createObservableHtml(html: HtmlTemplateTag): HtmlTemplateTag {
	return (strings, ...values) =>
		finalizeObservableHtmlResult(html(strings, ...values.map(coerceObservableHtmlValue)), strings);
}

function finalizeObservableHtmlResult(value: unknown, strings: TemplateStringsArray): unknown {
	const normalized = normalizeObservableHtmlResult(value, strings);
	installFormNamedProperties(normalized);
	return normalized;
}

function normalizeObservableHtmlResult(value: unknown, strings: TemplateStringsArray): unknown {
	if (!hasBoundaryWhitespace(strings)) return value;
	const element = singleElementChild(value);
	if (!element) return value;
	if (value instanceof DocumentFragment) return element;
	if (value instanceof HTMLElement && value.localName === "span" && value.attributes.length === 0) return element;
	return value;
}

function hasBoundaryWhitespace(strings: TemplateStringsArray): boolean {
	const first = strings[0] ?? "";
	const last = strings[strings.length - 1] ?? "";
	return first !== first.trimStart() || last !== last.trimEnd();
}

function singleElementChild(value: unknown): Element | null {
	if (!(value instanceof DocumentFragment || value instanceof HTMLElement)) return null;
	let element: Element | null = null;
	for (const child of value.childNodes) {
		if (child.nodeType === Node.ELEMENT_NODE) {
			if (element) return null;
			element = child as Element;
		} else if (child.nodeType === Node.TEXT_NODE) {
			if (/\S/.test(child.textContent ?? "")) return null;
		} else {
			return null;
		}
	}
	return element;
}

function coerceObservableHtmlValue(value: unknown): unknown {
	if (typeof value === "string") return htmlStringToFragment(value) ?? value;
	if (Array.isArray(value)) return value.map(coerceObservableHtmlValue);
	return value;
}

function htmlStringToFragment(value: string): DocumentFragment | null {
	if (!/<\/?[A-Za-z][^>]*>/.test(value)) return null;
	const template = document.createElement("template");
	template.innerHTML = value;
	if (!isSafeHtmlInterpolation(template.content)) return null;
	return template.content;
}

function isSafeHtmlInterpolation(fragment: DocumentFragment): boolean {
	const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_ELEMENT);
	let current = walker.nextNode();
	while (current) {
		const element = current as Element;
		if (!SAFE_HTML_INTERPOLATION_TAGS.has(element.localName)) return false;
		for (const attribute of Array.from(element.attributes)) {
			const name = attribute.name.toLowerCase();
			if (name.startsWith("on") || URL_HTML_ATTRIBUTES.has(name) || name === "style") return false;
		}
		current = walker.nextNode();
	}
	return true;
}

function installFormNamedProperties(value: unknown): void {
	if (!(value instanceof Element || value instanceof DocumentFragment)) return;
	const forms = value instanceof HTMLFormElement ? [value] : Array.from(value.querySelectorAll("form"));
	for (const form of forms) installFormNamedPropertiesFor(form);
}

function installFormNamedPropertiesFor(form: HTMLFormElement): void {
	for (const element of Array.from(form.elements)) {
		const name = element.getAttribute("name");
		if (!name || name in form) continue;
		Object.defineProperty(form, name, {
			configurable: true,
			get: () => form.elements.namedItem(name),
		});
	}
}

function ObservableMutable(this: unknown, value: unknown): object {
	let change: ((value: unknown) => unknown) | undefined;
	const generator = observe((notify) => {
		change = notify;
		if (value !== undefined) notify(value);
	});
	return Object.defineProperties(
		{},
		{
			generator: { value: generator },
			value: {
				get: () => value,
				set: (next) => {
					value = next;
					change?.(value);
				},
			},
		},
	);
}

export function createGenerators<T extends object>(Generators: T): T {
	return new Proxy(Generators, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver);
			if ((property === "observe" || property === "queue") && typeof value === "function") {
				return (...args: unknown[]) => syncIterableAsyncGenerator(value.apply(target, args));
			}
			return value;
		},
	});
}

function syncIterableAsyncGenerator<T>(value: T): T {
	if (!isAsyncGenerator(value) || Symbol.iterator in value) return value;
	return new Proxy(value, {
		get(target, property, receiver) {
			if (property === Symbol.iterator) return () => syncIteratorFromAsyncGenerator(target);
			return Reflect.get(target, property, receiver);
		},
	});
}

function syncIteratorFromAsyncGenerator<T>(generator: AsyncGenerator<T>): Iterator<Promise<T | undefined>> {
	return {
		next() {
			return {
				done: false,
				value: generator.next().then((result) => result.value),
			};
		},
		return() {
			void generator.return(undefined);
			return { done: true, value: undefined };
		},
	};
}

function isAsyncGenerator(value: unknown): value is AsyncGenerator<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as AsyncGenerator<unknown>).next === "function" &&
		typeof (value as AsyncGenerator<unknown>)[Symbol.asyncIterator] === "function"
	);
}
