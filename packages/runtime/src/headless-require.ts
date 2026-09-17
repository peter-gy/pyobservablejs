import { resolveImportDefault } from "@observablehq/notebook-kit";
import type { RuntimeValue } from "./values";
import { isObjectValue, isString } from "./value-kind";

type NativeRequire = {
	(...specifiers: string[]): Promise<RuntimeValue>;
	resolve(specifier: string): Promise<string>;
	alias(aliases: Readonly<Record<string, string | RuntimeValue>>): NativeRequire;
};

/** Load classic notebook package references through the host's native ESM loader. */
export function headlessRequire(aliases: Readonly<Record<string, RuntimeValue>> = {}): NativeRequire {
	const resolve = (specifier: string): string => {
		const npm = specifier.replace(/^https:\/\/(?:cdn.jsdelivr.net|cdn.observableusercontent.com)\/npm\//, "npm:");
		if (/^(https?:|data:|blob:)/.test(npm)) return npm;
		const bare = npm.replace(/^npm:/, "");
		const segments = bare.split("/");
		const name = segments.splice(0, bare.startsWith("@") ? 2 : 1).join("/");
		const path = segments.join("/");
		// The classic standard library names minified UMD entry files. Native
		// imports use the same pinned package's module entry instead of executing UMD.
		const entry = /^(?:(?:dist|build)\/)?[^/]+(?:\.min|\.umd|\.umd\.min)\.js$/.test(path);
		const resolved = resolveImportDefault(`npm:${name}${path && !entry ? `/${path}` : ""}`);
		return resolved.endsWith("/+esm") ? resolved : `${resolved}/+esm`;
	};
	const load = async (specifier: string): Promise<RuntimeValue> => {
		const alias = Object.prototype.hasOwnProperty.call(aliases, specifier) ? aliases[specifier] : undefined;
		if (alias !== undefined && !isString(alias)) return alias;
		const namespace: Record<string, RuntimeValue> = await import(/* @vite-ignore */ resolve(alias ?? specifier));
		return namespace.default ?? namespace;
	};
	const require = async (...specifiers: string[]): Promise<RuntimeValue> => {
		if (specifiers.length === 0) throw new TypeError("require expects at least one module");
		const modules = await Promise.all(specifiers.map(load));
		if (modules.length === 1) return modules[0];
		if (!modules.every(isObjectValue)) throw new TypeError("Multiple required modules must expose objects");
		return Object.assign({}, ...modules);
	};
	return Object.assign(require, {
		resolve: (specifier: string) => Promise.resolve(resolve(specifier)),
		alias: (next: Readonly<Record<string, RuntimeValue>>) => headlessRequire({ ...aliases, ...next }),
	});
}
