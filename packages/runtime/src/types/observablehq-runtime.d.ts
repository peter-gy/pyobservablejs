declare module "@observablehq/runtime" {
	export type RuntimeValue = null | undefined | boolean | number | bigint | string | symbol | object;
	export type RuntimeLibrary = Record<string, RuntimeValue>;
	// Observable definitions receive the values of their declared inputs, whose types are determined by the notebook graph.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	export type VariableDefinition = (...inputs: any[]) => RuntimeValue;

	type VariableOptions = {
		shadow?: Record<string, () => RuntimeValue>;
	};

	export type ObserverOption = Observer | boolean | null;
	export type ObserverFactory = (name: string) => ObserverOption;
	export type ModuleDefinition = (runtime: Runtime, observer: ObserverFactory) => Module | void;

	export interface Observer {
		pending?(): void;
		fulfilled?(value: RuntimeValue, name?: string): void;
		rejected?(cause: RuntimeValue, name?: string): void;
	}

	export class Runtime {
		constructor(library?: RuntimeLibrary);
		_builtin: Module;
		_compute(): Promise<void>;
		dispose(): void;
		module(define?: ModuleDefinition, observer?: ObserverFactory): Module;
	}

	export class Module {
		_runtime: Runtime;
		_builtins: Map<string, RuntimeValue>;
		_scope: Map<string, Variable>;
		_resolve(name: string): Variable;
		variable(observer?: ObserverOption, options?: VariableOptions): Variable;
		define(inputs: string[], definition: VariableDefinition): Variable;
		define(name: string | null, inputs: string[], definition: VariableDefinition): Variable;
		import(name: string, module: Module): Variable;
		import(remote: string, name: string, module: Module): Variable;
		redefine(name: string, inputs: string[], definition: VariableDefinition): Variable;
		value(name: string): Promise<RuntimeValue>;
	}

	export class Variable {
		_module: Module;
		_observer: ObserverOption;
		_version: number;
		_shadow: Map<string, Variable>;
		_promise: Promise<RuntimeValue>;
		_definition: RuntimeValue;
		constructor(type: number, module: Module, observer?: ObserverOption, options?: VariableOptions);
		define(inputs: string[], definition: VariableDefinition): Variable;
		define(name: string | null, inputs: string[], definition: VariableDefinition): Variable;
		import(name: string, module: Module): Variable;
		import(remote: string, name: string, module: Module): Variable;
		delete(): Variable;
	}
}
