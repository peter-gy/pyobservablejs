import { isBigInt, isBoolean, isNumber, isObjectValue, isString } from "./value-kind";
import type { RuntimeValue } from "./values";

export type DiagnosticOrigin = "notebook" | "runtime" | "widget";
export type DiagnosticPhase = "analysis" | "evaluation" | "rendering" | "serialization" | "transport";
export type ErrorDetail = Readonly<{ name: string; message: string; stack?: string; cause?: ErrorDetail }>;
type MutableErrorDetail = { -readonly [Key in keyof ErrorDetail]: ErrorDetail[Key] };
export type DiagnosticCell = Readonly<{ index: number; id: number; key: string; mode: string; source: string }>;
export type Diagnostic = ErrorDetail &
	Readonly<{
		origin: DiagnosticOrigin;
		phase: DiagnosticPhase;
		component: string;
		operation: string;
		variable?: string;
		cell?: DiagnosticCell;
	}>;
export type DiagnosticContext = Omit<Diagnostic, keyof ErrorDetail>;

export class DiagnosticError extends Error {
	readonly diagnostic: Diagnostic;
	readonly diagnostics: readonly Diagnostic[];
	readonly cause?: RuntimeValue;
	constructor(diagnostic: Diagnostic | readonly Diagnostic[], cause?: RuntimeValue) {
		const diagnostics = "message" in diagnostic ? [diagnostic] : diagnostic;
		const first = diagnostics[0];
		if (!first) throw new TypeError("DiagnosticError requires a diagnostic");
		super(first.message);
		this.name = "DiagnosticError";
		this.diagnostic = first;
		this.diagnostics = Object.freeze([...diagnostics]);
		this.cause = cause;
	}
}

export function errorDetails<Cause>(cause: Cause): ErrorDetail {
	const existing = diagnosticOf(cause);
	if (existing) {
		const { name, message, stack, cause: nested } = existing;
		const details: MutableErrorDetail = { name, message };
		if (stack !== undefined) details.stack = stack;
		if (nested !== undefined) details.cause = nested;
		return Object.freeze(details);
	}
	return detail(cause, new WeakSet(), 0);
}

export function createDiagnostic<Cause>(cause: Cause, context: DiagnosticContext): Diagnostic {
	const existing = diagnosticOf(cause);
	if (existing) return existing;
	const diagnostic = { ...errorDetails(cause), ...context };
	if (context.cell) diagnostic.cell = Object.freeze({ ...context.cell, source: clip(context.cell.source, 32768) });
	return Object.freeze(diagnostic);
}

function diagnosticOf<Value>(value: Value): Diagnostic | undefined {
	try {
		if (value instanceof DiagnosticError) return value.diagnostic;
	} catch {}
	return undefined;
}

function detail<Value>(value: Value, seen: WeakSet<object>, depth: number): ErrorDetail {
	const rawName = property(value, "name");
	const rawMessage = property(value, "message");
	const error: MutableErrorDetail = {
		name: isString(rawName) && rawName ? clip(rawName, 256) : "Error",
		message: isString(rawMessage) ? clip(rawMessage, 8192) : thrownMessage(value),
	};
	const stack = property(value, "stack");
	if (isString(stack)) error.stack = clip(stack, 16384);
	if (isObjectValue(value) && !seen.has(value) && depth < 5) {
		seen.add(value);
		const cause = property(value, "cause");
		if (cause !== undefined && (!isObjectValue(cause) || !seen.has(cause)))
			error.cause = detail(cause, seen, depth + 1);
	}
	return Object.freeze(error);
}

function property<Value>(
	value: Value,
	key: string,
): object | string | number | boolean | bigint | symbol | null | undefined {
	try {
		let current: object | null = isObjectValue(value) ? value : null;
		for (let depth = 0; current && depth < 10; depth++) {
			const descriptor = Object.getOwnPropertyDescriptor(current, key);
			if (descriptor) {
				if ("value" in descriptor) return descriptor.value;
				if (
					key === "stack" &&
					value instanceof Error &&
					descriptor.get &&
					Function.prototype.toString.call(descriptor.get).includes("[native code]")
				)
					return descriptor.get.call(value);
				return undefined;
			}
			current = Object.getPrototypeOf(current);
		}
	} catch {}
	return undefined;
}

function thrownMessage<Value>(value: Value): string {
	if (isString(value)) return clip(value, 8192);
	if (value === null || value === undefined || isNumber(value) || isBoolean(value)) return String(value);
	if (isBigInt(value) && value > -(1n << 256n) && value < 1n << 256n) return String(value);
	return "A non-Error value was thrown";
}

function clip(value: string, limit: number): string {
	return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

export class DiagnosticCollector {
	#cells = new Map<number, Map<string, Diagnostic>>();
	#global = new Map<string, Diagnostic>();
	#snapshot: readonly Diagnostic[] = Object.freeze([]);
	#dirty = false;
	#scheduled = false;
	#closed = false;
	#listeners = new Set<() => void>();
	#callbackFailed = false;
	constructor(private readonly onDiagnostics?: (errors: readonly Diagnostic[]) => void) {}
	get errors(): readonly Diagnostic[] {
		if (this.#dirty) {
			this.#snapshot = Object.freeze([
				...this.#global.values(),
				...[...this.#cells.values()].flatMap((cells) => [...cells.values()]),
			]);
			this.#dirty = false;
		}
		return this.#snapshot;
	}
	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	getCell(index: number, channel: string): Diagnostic | undefined {
		return this.#cells.get(index)?.get(channel);
	}
	report(diagnostic: Diagnostic, channel = diagnostic.operation): Diagnostic {
		if (this.#closed) return diagnostic;
		if (diagnostic.cell) {
			let cells = this.#cells.get(diagnostic.cell.index);
			if (!cells) this.#cells.set(diagnostic.cell.index, (cells = new Map()));
			cells.set(channel, diagnostic);
		} else this.#global.set(channel, diagnostic);
		this.#changed();
		return diagnostic;
	}
	clearCell(index: number): void {
		if (this.#cells.delete(index)) this.#changed();
	}
	clear(): void {
		if (!this.#cells.size && !this.#global.size) return;
		this.#cells.clear();
		this.#global.clear();
		this.#callbackFailed = false;
		this.#changed();
	}
	close(): void {
		this.#closed = true;
		this.#listeners.clear();
	}
	#changed(): void {
		this.#dirty = true;
		for (const listener of this.#listeners) listener();
		if (!this.onDiagnostics || this.#scheduled || this.#callbackFailed) return;
		this.#scheduled = true;
		queueMicrotask(() => {
			this.#scheduled = false;
			if (this.#closed) return;
			try {
				this.onDiagnostics?.(this.errors);
			} catch (cause) {
				this.#callbackFailed = true;
				this.report(
					createDiagnostic(cause, {
						origin: "runtime",
						phase: "transport",
						component: "packages/runtime/src/diagnostics.ts",
						operation: "publish diagnostics",
					}),
				);
			}
		});
	}
}
