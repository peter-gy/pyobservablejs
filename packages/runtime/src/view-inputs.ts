import {
	isClickInput,
	isViewTarget,
	readViewValue,
	writeViewValue,
	type RuntimeVariablesSync,
	type ViewTarget,
	type ViewWriteResult,
} from "./views";
import { sameValue, type RuntimeValue, type Variables } from "./values";
import { isObjectValue } from "./value-kind";

export type RuntimeViewSync = {
	register(name: string, value: RuntimeValue): void;
	set(values: Variables): void;
	clear(names: ReadonlySet<string>): void;
};

const programmaticWrites = new WeakSet<ViewTarget>();

export function writeProgrammaticViewValue(view: ViewTarget, value: RuntimeValue): ViewWriteResult {
	programmaticWrites.add(view);
	try {
		return writeViewValue(view, value);
	} finally {
		programmaticWrites.delete(view);
	}
}

export function createRuntimeViewSync({
	variables,
	initialValues,
	signal,
	onChange,
	onInput,
	onError,
}: {
	variables: RuntimeVariablesSync;
	initialValues: Variables;
	signal: AbortSignal;
	onChange(names: ReadonlySet<string>): void;
	onInput(name: string, value: RuntimeValue): void;
	onError<Cause>(name: string, cause: Cause, operation: string): void;
}): RuntimeViewSync {
	const views = new Map<string, ViewTarget>();
	const cleanups = new Map<string, () => void>();
	let values = { ...initialValues };
	const hasValue = (name: string) => Object.prototype.hasOwnProperty.call(values, name);
	signal.addEventListener(
		"abort",
		() => {
			for (const cleanup of cleanups.values()) cleanup();
		},
		{ once: true },
	);
	return {
		set(next) {
			const changed = new Set(
				Object.entries(next)
					.filter(
						([name, value]) =>
							!Object.prototype.hasOwnProperty.call(values, name) ||
							isObjectValue(value) ||
							!sameValue(values[name], value),
					)
					.map(([name]) => name),
			);
			values = { ...next };
			const applied = new Set<string>();
			for (const name of changed) {
				const view = views.get(name);
				try {
					if (view && writeProgrammaticViewValue(view, values[name]) === "applied") applied.add(name);
				} catch (cause) {
					onError(name, cause, "replay input");
				}
			}
			if (applied.size > 0) onChange(applied);
		},
		clear(names) {
			for (const name of names) delete values[name];
		},
		register(name, value) {
			if (signal.aborted || !isViewTarget(value)) return;
			if (views.get(name) === value) {
				variables.setView(name, value, { applyInitialVariable: !hasValue(name) });
				return;
			}
			cleanups.get(name)?.();
			views.set(name, value);
			let pairedInput = false;
			const onInteraction = (event: Event) => {
				if (programmaticWrites.has(value) || signal.aborted || views.get(name) !== value) return;
				if (event.type === "change" && pairedInput) return;
				if (event.type === "input") {
					pairedInput = true;
					queueMicrotask(() => {
						pairedInput = false;
					});
				}
				try {
					const next = readViewValue(value);
					// Native objects can change in place between input events.
					if (hasValue(name) && !isObjectValue(next) && sameValue(values[name], next)) return;
					onChange(new Set([name]));
					values = { ...values, [name]: next };
					onInput(name, next);
				} catch (cause) {
					onError(name, cause, "read input");
				}
			};
			const cleanup = () => {
				for (const event of ["input", "change", "click"]) {
					try {
						value.removeEventListener(event, onInteraction);
					} catch (cause) {
						onError(name, cause, "dispose input");
					}
				}
				if (views.get(name) === value) views.delete(name);
				if (cleanups.get(name) === cleanup) cleanups.delete(name);
				variables.deleteView(name, value);
			};
			cleanups.set(name, cleanup);
			try {
				value.addEventListener("input", onInteraction);
				value.addEventListener("change", onInteraction);
				if (isClickInput(value)) value.addEventListener("click", onInteraction);
				if (hasValue(name)) writeProgrammaticViewValue(value, values[name]);
				variables.setView(name, value, { applyInitialVariable: !hasValue(name) });
			} catch (cause) {
				cleanup();
				onError(name, cause, "register input");
			}
		},
	};
}
