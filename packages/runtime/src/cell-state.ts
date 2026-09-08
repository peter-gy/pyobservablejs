import type { RuntimeValue } from "./values";
import { structuredCellError, type CellError, type CellResult, type ErrorPhase, type EvaluationToken } from "./state";

export type CellVariableSync = {
	configure(names: string[], display: boolean): void;
	pending(channel: string): void;
	fulfilled(channel: string, name?: string, value?: RuntimeValue): void;
	rejected<Cause>(channel: string, cause: Cause, phase: ErrorPhase, variable?: string): void;
	fail<Cause>(cause: Cause, phase: ErrorPhase, variable?: string): void;
};

/** Aggregate every observer channel into one selected-cell result. */
export function createCellStateSync({
	begin,
	settle,
}: {
	begin(channel: string, generation: number): EvaluationToken | null;
	settle(token: EvaluationToken, value: Omit<CellResult, "revision">): void;
}): CellVariableSync {
	const expected = new Set<string>();
	const statuses = new Map<string, "pending" | "success" | "error">();
	const generations = new Map<string, number>();
	const values = new Map<string, { name: string; value: RuntimeValue }>();
	const errors = new Map<string, CellError>();

	const start = (channel: string): EvaluationToken | null => {
		const generation = (generations.get(channel) ?? 0) + 1;
		generations.set(channel, generation);
		const token = begin(channel, generation);
		if (!token) return null;
		statuses.set(channel, "pending");
		values.delete(channel);
		errors.delete(channel);
		return token;
	};

	const settleIfReady = (token: EvaluationToken) => {
		if ([...expected].some((channel) => statuses.get(channel) === "pending")) return;
		const resultErrors = [...errors.values()];
		settle(token, {
			status: resultErrors.length > 0 ? "error" : "success",
			values: Object.fromEntries([...values.values()].map((item) => [item.name, item.value])),
			errors: resultErrors,
		});
	};

	return {
		configure(names, display) {
			expected.clear();
			if (display) expected.add("display");
			for (const name of names) expected.add(`variable:${name}`);
			for (const channel of expected) {
				if (!statuses.has(channel)) statuses.set(channel, "pending");
			}
		},
		pending(channel) {
			start(channel);
		},
		fulfilled(channel, name, value) {
			// Observable rejects stale evaluations before notifying observers. A first
			// generator yield may arrive in a newer input revision than its pending event.
			const token = start(channel);
			if (!token) return;
			statuses.set(channel, "success");
			if (name !== undefined) {
				values.set(channel, { name, value });
			}
			errors.delete(channel);
			settleIfReady(token);
		},
		rejected(channel, error, phase, variable) {
			const token = start(channel);
			if (!token) return;
			statuses.set(channel, "error");
			values.delete(channel);
			errors.set(channel, structuredCellError(error, phase, variable));
			settleIfReady(token);
		},
		fail(error, phase, variable) {
			const channel = "failure";
			expected.clear();
			expected.add(channel);
			const token = start(channel);
			if (!token) return;
			statuses.set(channel, "error");
			errors.set(channel, structuredCellError(error, phase, variable));
			settleIfReady(token);
		},
	};
}
