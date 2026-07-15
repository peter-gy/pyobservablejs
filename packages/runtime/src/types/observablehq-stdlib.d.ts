declare module "@observablehq/stdlib" {
	export class Library {
		constructor(resolver?: (specifier: string, base?: string) => string | Promise<string>);
		[name: string]: unknown;
	}
}
