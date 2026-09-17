import { DiagnosticError, type DiagnosticCollector } from "./diagnostics";
import type { EvaluationState, NotebookState } from "./state";
export function readyState(
	state: EvaluationState,
	diagnostics: DiagnosticCollector,
	readySignal: AbortSignal,
): Promise<NotebookState> {
	return new Promise((resolve, reject) => {
		let unsubscribeState = () => {};
		let unsubscribeDiagnostics = () => {};
		const cleanup = () => {
			unsubscribeState();
			unsubscribeDiagnostics();
			readySignal.removeEventListener("abort", abort);
		};
		const abort = () => {
			cleanup();
			reject(new DOMException("Notebook ready cancelled", "AbortError"));
		};
		const check = () => {
			if (readySignal.aborted) return abort();
			const errors = diagnostics.errors;
			const fatal = errors.filter(
				(error) => error.origin !== "notebook" || error.phase === "serialization" || error.phase === "transport",
			);
			if (fatal.length) {
				cleanup();
				reject(new DiagnosticError(fatal));
				return;
			}
			if (state.inputRevision === null || state.pending || state.inputRevision !== state.settledRevision) return;
			cleanup();
			if (errors.length) reject(new DiagnosticError(errors));
			else resolve(state.state);
		};
		unsubscribeState = state.subscribe(check);
		unsubscribeDiagnostics = diagnostics.subscribe(check);
		readySignal.addEventListener("abort", abort, { once: true });
		check();
	});
}
