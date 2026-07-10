import { library } from "@observablehq/notebook-kit/runtime";
import { unprefix, type RuntimeCellDefinition } from "./definition";

type HtmlTemplateTag = (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
type LegacyRequire = {
	(...specifiers: unknown[]): Promise<unknown>;
	resolve(specifier: unknown): string;
	alias(aliases: Record<string, unknown>): LegacyRequire;
};
type NpmSpecifier = {
	name: string;
	range: string;
	path: string;
};
export type RuntimeCompatibilityOptions = {
	displayView?: boolean;
	generators?: boolean;
	html?: boolean;
	mutable?: boolean;
	require?: boolean;
};
type RuntimeCompatibilityBuiltin = {
	create(): unknown;
	enabled(options: RuntimeCompatibilityOptions): boolean;
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
	Generators: {
		create: () => createGenerators(library.Generators()),
		enabled: (options) => options.generators === true,
	},
	Mutable: {
		create: () => createMutable(library.Mutable()),
		enabled: (options) => options.mutable === true,
	},
	html: {
		create: () => loadHtmlBuiltin(),
		enabled: (options) => options.html === true,
	},
	require: {
		create: () => legacyRequire,
		enabled: (options) => options.require === true,
	},
} satisfies Record<string, RuntimeCompatibilityBuiltin>;

type RuntimeCompatibilityBuiltinName = keyof typeof RUNTIME_COMPAT_BUILTINS;

export const RUNTIME_COMPAT_BUILTIN_NAMES = Object.keys(RUNTIME_COMPAT_BUILTINS) as RuntimeCompatibilityBuiltinName[];

export function runtimeCompatibilityBuiltinNames(
	options: RuntimeCompatibilityOptions = {},
): RuntimeCompatibilityBuiltinName[] {
	return RUNTIME_COMPAT_BUILTIN_NAMES.filter((name) => RUNTIME_COMPAT_BUILTINS[name].enabled(options));
}

export function createRuntimeCompatibilityBuiltins(
	options: RuntimeCompatibilityOptions = {},
): Partial<Record<RuntimeCompatibilityBuiltinName, () => unknown>> {
	const builtins: Partial<Record<RuntimeCompatibilityBuiltinName, () => unknown>> = {};
	for (const name of runtimeCompatibilityBuiltinNames(options)) builtins[name] = RUNTIME_COMPAT_BUILTINS[name].create;
	return builtins;
}

export function runtimeDefinitionCompatibility(
	definition: RuntimeCellDefinition,
	notebookNames: ReadonlySet<string> | undefined,
	compatibility: RuntimeCompatibilityOptions = {},
): { display?: false } {
	if (compatibility.displayView !== true) return {};
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

function createLegacyRequire(resolve: (specifier: unknown) => unknown): LegacyRequire {
	const require = (async (...specifiers: unknown[]) => {
		if (specifiers.length === 1) return loadRequiredModule(resolve(specifiers[0]));
		return Promise.all(specifiers.map((specifier) => require(specifier))).then(mergeModules);
	}) as LegacyRequire;
	require.resolve = (specifier) => {
		const resolved = resolve(specifier);
		return typeof resolved === "string" ? resolveLegacyRequire(resolved) : String(specifier);
	};
	require.alias = legacyRequireAlias;
	return require;
}

function legacyRequireAlias(aliases: Record<string, unknown>): LegacyRequire {
	return createLegacyRequire((specifier) => {
		const key = String(specifier);
		return Object.prototype.hasOwnProperty.call(aliases, key) ? aliases[key] : resolveLegacyRequire(specifier);
	});
}

function loadRequiredModule(resolved: unknown): Promise<unknown> {
	if (typeof resolved === "string") return import(/* @vite-ignore */ resolved).then(objectifyModule);
	return Promise.resolve(resolved);
}

function resolveLegacyRequire(specifier: unknown): string {
	const value = String(specifier);
	if (isProtocol(value) || isLocal(value)) return value;
	const { name, range, path } = parseNpmSpecifier(value);
	return `https://cdn.jsdelivr.net/npm/${name}${range || notebookKitDefaultRange(name)}${
		path ? notebookKitPath(path) : notebookKitDefaultPath(name)
	}`;
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

function notebookKitPath(path: string): string {
	return /(\.\w+|\/|\/\+esm)$/.test(path) ? path : `${path}/+esm`;
}

function notebookKitDefaultRange(name: string): string {
	switch (name) {
		case "@duckdb/duckdb-wasm":
			return "@1.32.0";
		case "apache-arrow":
			return "@17.0.0";
		default:
			return "";
	}
}

function notebookKitDefaultPath(name: string): string {
	switch (name) {
		case "mermaid":
			return "/dist/mermaid.esm.min.mjs/+esm";
		case "echarts":
			return "/dist/echarts.esm.min.js/+esm";
		case "jquery-ui":
			return "/dist/jquery-ui.js/+esm";
		case "deck.gl":
			return "/dist.min.js/+esm";
		case "react-dom":
			return "/client/+esm";
		default:
			return "/+esm";
	}
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
	if (isSyntheticHtmlSpanWrapper(value, strings)) return element;
	return value;
}

function isSyntheticHtmlSpanWrapper(value: unknown, strings: TemplateStringsArray): boolean {
	return (
		value instanceof HTMLElement &&
		value.localName === "span" &&
		value.attributes.length === 0 &&
		strings.every((part) => part.trim() === "")
	);
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

function createMutable(Mutable: unknown): unknown {
	if (typeof Mutable !== "function") return Mutable;
	return new Proxy(Mutable, {
		construct(target, args, newTarget) {
			return addLegacyMutableGenerator(Reflect.construct(target, args, newTarget)) as object;
		},
		apply(target, thisArg, args) {
			return addLegacyMutableGenerator(Reflect.apply(target, thisArg, args));
		},
	});
}

function addLegacyMutableGenerator<T>(value: T): T {
	if (typeof value === "object" && value !== null && !("generator" in value)) {
		Object.defineProperty(value, "generator", {
			configurable: true,
			value,
		});
	}
	return value;
}

export function createGenerators<T extends object>(Generators: T): T {
	return new Proxy(Generators, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver);
			if ((property === "observe" || property === "queue" || property === "input") && typeof value === "function") {
				return (...args: unknown[]) => syncIterableAsyncGenerator(value.apply(target, args));
			}
			return value;
		},
	});
}

function syncIterableAsyncGenerator<T>(value: T): T {
	if (!isAsyncGenerator(value) || Symbol.iterator in value) return value;
	return new Proxy(value, {
		has(target, property) {
			return property === Symbol.iterator || property in Object(target);
		},
		get(target, property) {
			if (property === Symbol.iterator) return () => syncIteratorFromAsyncGenerator(target);
			const resolved = Reflect.get(target, property, target);
			return isGeneratorMethod(property) && typeof resolved === "function" ? resolved.bind(target) : resolved;
		},
	});
}

function isGeneratorMethod(property: PropertyKey): boolean {
	return (
		property === "next" ||
		property === "return" ||
		property === "throw" ||
		property === Symbol.asyncIterator ||
		property === Symbol.asyncDispose
	);
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
			return {
				done: true,
				value: generator.return(undefined).then((result) => result.value),
			};
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
