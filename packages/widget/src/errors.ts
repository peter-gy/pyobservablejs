import { createDiagnostic, errorDetails, type Diagnostic, type DiagnosticPhase } from "@pyobservablejs/runtime";
import { isNumber } from "@pyobservablejs/runtime/values";
import type { AnyWidgetModel, WireDiagnostics } from "./model";
import { sameWireValue } from "./values";

export type DiagnosticContext = {
	phase: DiagnosticPhase;
	component: string;
	operation: string;
	variable?: string;
};
export type DiagnosticScope = {
	replace(channel: string, errors: readonly Diagnostic[]): void;
	report(cause: unknown, context: DiagnosticContext): void;
	clear(context: DiagnosticContext): void;
};

export class DiagnosticPublisher {
	readonly #model: AnyWidgetModel;
	readonly #signal: AbortSignal;
	readonly #el: HTMLElement;
	#revision: number;
	#generation = 0;
	#channels = new Map<string, readonly Diagnostic[]>();
	#scheduled = false;
	#dirty = false;
	#sequence = 0;
	#readSequence: () => number = () => this.#sequence;

	constructor(model: AnyWidgetModel, signal: AbortSignal, el: HTMLElement) {
		this.#model = model;
		this.#signal = signal;
		this.#el = el;
		const previous = model.get("_diagnostics");
		const revision = previous?.revision;
		const sequence = previous?.sequence;
		if (isNumber(sequence) && Number.isSafeInteger(sequence) && sequence >= 0) this.#sequence = sequence;
		this.#revision = isNumber(revision) && Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
	}

	start(sequence: () => number = () => this.#sequence): DiagnosticScope {
		this.#readSequence = sequence;
		const generation = ++this.#generation;
		this.#channels.clear();
		this.#schedule();
		return {
			clear: (context) => {
				if (this.#signal.aborted || generation !== this.#generation) return;
				if (this.#channels.delete(diagnosticKey(context))) this.#schedule();
			},
			replace: (channel, errors) => {
				if (this.#signal.aborted || generation !== this.#generation) return;
				if (sameWireValue(this.#channels.get(channel), errors)) return;
				this.#channels.set(channel, errors);
				this.#schedule();
			},
			report: (cause, context) => {
				if (this.#signal.aborted || generation !== this.#generation) return;
				this.report(cause, context);
			},
		};
	}

	report(cause: unknown, context: DiagnosticContext): void {
		if (this.#signal.aborted) return;
		this.#channels.set(diagnosticKey(context), [createDiagnostic(cause, { origin: "widget", ...context })]);
		this.#schedule();
	}

	snapshot(): WireDiagnostics {
		this.#schedule();
		this.flush();
		const { revision, sequence, errors } = this.#model.get("_diagnostics") ?? {};
		if (revision === undefined || sequence === undefined || errors === undefined)
			throw new Error("View diagnostics are unavailable");
		return { revision, sequence, errors };
	}

	flush(): void {
		if (!this.#dirty || this.#signal.aborted) return;
		this.#dirty = false;
		const errors = [...this.#channels.values()].flat();
		try {
			const current = this.#model.get("_diagnostics");
			if (current?.sequence === this.#sequence && sameWireValue(current.errors, errors)) return;
			this.#model.set("_diagnostics", { revision: ++this.#revision, sequence: this.#sequence, errors });
			this.#model.save_changes();
		} catch (cause) {
			showError(this.#el, cause);
		}
	}

	#schedule(): void {
		this.#sequence = this.#readSequence();
		this.#dirty = true;
		if (this.#scheduled) return;
		this.#scheduled = true;
		queueMicrotask(() => {
			this.#scheduled = false;
			this.flush();
		});
	}
}

export function showError<Cause>(el: HTMLElement, cause: Cause): void {
	const pre = el.ownerDocument.createElement("pre");
	pre.setAttribute("role", "alert");
	const detail = errorDetails(cause);
	pre.textContent = `${detail.name}: ${detail.message}`;
	el.replaceChildren(pre);
}

function diagnosticKey(context: DiagnosticContext): string {
	return `${context.component}:${context.operation}:${context.variable ?? ""}`;
}
