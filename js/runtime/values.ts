const TYPE_KEY = "__pyobservablejs_type__";

// anywidget traits carry JSON. __pyobservablejs_type__ tags preserve values that
// need browser or Python revival.

export type ViewTarget = EventTarget & {
	value?: unknown;
	checked?: boolean;
};

export type RuntimeVariablesSync = {
	applyInitialViews(): void;
	setView(name: string, view: ViewTarget, onVariableRelease?: () => void): void;
	deleteView(name: string, view: ViewTarget): void;
};

export type NestedSelectState = Array<{
	selectedIndex: number;
	value: string;
}>;

type WireContext = {
	seen: WeakMap<object, number>;
	nextId: number;
};

export function toWireValue(value: unknown, context: WireContext = { seen: new WeakMap(), nextId: 1 }): unknown {
	// Summarize live browser objects before trait sync attempts JSON cloning.
	if (value === undefined) return { [TYPE_KEY]: "undefined" };
	if (value === null || typeof value === "boolean" || typeof value === "string") return value;
	if (typeof value === "number") {
		if (Number.isFinite(value)) return value;
		if (Number.isNaN(value)) return { [TYPE_KEY]: "number", value: "NaN" };
		return { [TYPE_KEY]: "number", value: value > 0 ? "Infinity" : "-Infinity" };
	}
	if (typeof value === "bigint") {
		return { [TYPE_KEY]: "bigint", value: value.toString() };
	}
	if (typeof value === "function") {
		return { [TYPE_KEY]: "function", value: value.name || "anonymous" };
	}
	if (value instanceof Date) {
		return { [TYPE_KEY]: "datetime", value: value.toISOString() };
	}
	if (value instanceof Element) {
		return { [TYPE_KEY]: "element", value: value.tagName.toLowerCase() };
	}
	if (value instanceof Error) {
		return { [TYPE_KEY]: "error", name: value.name, message: value.message };
	}
	if (value instanceof RegExp) {
		return { [TYPE_KEY]: "regexp", value: String(value) };
	}
	if (typeof File !== "undefined" && value instanceof File) {
		return { [TYPE_KEY]: "file", name: value.name, size: value.size, mimeType: value.type };
	}
	if (typeof Blob !== "undefined" && value instanceof Blob) {
		return { [TYPE_KEY]: "blob", size: value.size, mimeType: value.type };
	}
	if (value instanceof ArrayBuffer) {
		return { [TYPE_KEY]: "arraybuffer", value: bytesToBase64(new Uint8Array(value)) };
	}
	if (ArrayBuffer.isView(value)) {
		const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
		return {
			[TYPE_KEY]: "typedarray",
			name: value.constructor.name,
			value: bytesToBase64(bytes),
		};
	}
	if (Array.isArray(value)) {
		const ref = context.seen.get(value);
		if (ref !== undefined) return { [TYPE_KEY]: "reference", value: ref };
		context.seen.set(value, context.nextId++);
		return value.map((item) => toWireValue(item, context));
	}
	if (isRecord(value)) {
		const ref = context.seen.get(value);
		if (ref !== undefined) return { [TYPE_KEY]: "reference", value: ref };
		context.seen.set(value, context.nextId++);
		if (value instanceof Map) {
			return {
				[TYPE_KEY]: "map",
				value: Array.from(value, ([key, item]) => [toWireValue(key, context), toWireValue(item, context)]),
			};
		}
		if (value instanceof Set) {
			return { [TYPE_KEY]: "set", value: Array.from(value, (item) => toWireValue(item, context)) };
		}
		const entries = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toWireValue(item, context)]));
		if (TYPE_KEY in entries) return { [TYPE_KEY]: "object", value: entries };
		return entries;
	}
	return { [TYPE_KEY]: typeof value, value: String(value) };
}

export function reviveSyncedValue(value: unknown): unknown {
	// Cell traits store values used for `viewof` writes and isolated dependencies.
	if (Array.isArray(value)) return value.map(reviveSyncedValue);
	if (!isRecord(value)) return value;
	const type = value[TYPE_KEY];
	if (type === "undefined") return undefined;
	if (type === "number") return reviveNumber(String(value.value));
	if (type === "bigint") return BigInt(String(value.value));
	if (type === "datetime") return new Date(String(value.value));
	if (type === "object") return revivePlainObject(value.value);
	if (type === "map" && Array.isArray(value.value)) {
		return new Map(value.value.map((entry) => (Array.isArray(entry) ? entry.map(reviveSyncedValue) : entry)));
	}
	if (type === "set" && Array.isArray(value.value)) return new Set(value.value.map(reviveSyncedValue));
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, reviveSyncedValue(item)]));
}

export function sameWireValue(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

export function createVariableBuiltins(variables: Record<string, unknown>): Record<string, () => unknown> {
	// Observable builtins are thunks. Cache revived Python values per variable.
	const builtins: Record<string, () => unknown> = {};
	const cache = new Map<string, unknown>();
	for (const [name, value] of Object.entries(variables)) {
		builtins[name] = () => {
			if (!cache.has(name)) cache.set(name, revivePythonValue(value));
			return cache.get(name);
		};
	}
	return builtins;
}

export function revivePythonValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return resolveMaybePromises(value.map(revivePythonValue), (items) => items);
	}
	if (!isRecord(value)) return value;

	const type = value[TYPE_KEY];
	if (type === "datetime") return new Date(String(value.value));
	if (type === "bytes") return base64ToBytes(String(value.value));
	if (type === "number") return reviveNumber(String(value.value));
	if (type === "bigint") return BigInt(String(value.value));
	if (type === "object") return revivePlainPythonObject(value.value);

	const entries = Object.entries(value).map(([key, entry]) => [key, revivePythonValue(entry)] as const);
	return resolveMaybePromises(
		entries.map(([, entry]) => entry),
		(items) => Object.fromEntries(entries.map(([key], index) => [key, items[index]])),
	);
}

function resolveMaybePromises<T>(values: unknown[], finish: (values: unknown[]) => T): T | Promise<T> {
	if (values.some(isPromiseLike)) return Promise.all(values).then(finish);
	return finish(values);
}

function revivePlainObject(value: unknown): unknown {
	if (!isRecord(value)) return reviveSyncedValue(value);
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, reviveSyncedValue(item)]));
}

function revivePlainPythonObject(value: unknown): unknown {
	if (!isRecord(value)) return revivePythonValue(value);
	const entries = Object.entries(value).map(([key, entry]) => [key, revivePythonValue(entry)] as const);
	return resolveMaybePromises(
		entries.map(([, entry]) => entry),
		(items) => Object.fromEntries(entries.map(([key], index) => [key, items[index]])),
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return isRecord(value) && typeof value.then === "function";
}

function reviveNumber(value: string): number {
	if (value === "NaN") return Number.NaN;
	if (value === "Infinity") return Number.POSITIVE_INFINITY;
	if (value === "-Infinity") return Number.NEGATIVE_INFINITY;
	return Number(value);
}

function base64ToBytes(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

function bytesToBase64(value: Uint8Array): string {
	let binary = "";
	for (const byte of value) binary += String.fromCharCode(byte);
	return btoa(binary);
}

export function isViewTarget(value: unknown): value is ViewTarget {
	return value instanceof EventTarget && "value" in value;
}

export function readViewValue(view: ViewTarget): unknown {
	if (view instanceof HTMLInputElement) {
		if (view.type === "checkbox") return view.checked;
		if (view.type === "number" || view.type === "range") return view.valueAsNumber;
		return view.value;
	}
	if (view instanceof HTMLSelectElement && view.multiple) {
		return Array.from(view.selectedOptions, (option) => option.value);
	}
	return view.value;
}

export function readNestedSelectState(view: ViewTarget): NestedSelectState | undefined {
	const selects = nestedSelects(view);
	if (selects.length === 0) return undefined;
	return selects.map((select) => ({
		selectedIndex: select.selectedIndex,
		value: select.value,
	}));
}

export function writeViewValue(view: ViewTarget, value: unknown, nestedState?: NestedSelectState): boolean {
	const expected = expectedWireValue(view, value);
	if (view instanceof HTMLInputElement) {
		if (view.type === "checkbox") {
			view.checked = Boolean(value);
			view.value = String(value);
			view.dispatchEvent(new Event("click", { bubbles: true }));
		} else if (view.type === "date" && value instanceof Date) {
			view.value = value.toISOString().slice(0, 10);
		} else if (view.type === "datetime-local" && value instanceof Date) {
			view.value = value.toISOString().slice(0, 16);
		} else {
			view.value = value == null ? "" : String(value);
		}
	} else if (view instanceof HTMLSelectElement && view.multiple && Array.isArray(value)) {
		const selected = new Set(value.map(String));
		for (const option of view.options) option.selected = selected.has(option.value);
	} else {
		view.value = value;
		restoreNestedSelectValue(view, value, nestedState);
	}
	if (!sameWireValue(toWireValue(readViewValue(view)), expected)) return false;
	view.dispatchEvent(new Event("input", { bubbles: true }));
	view.dispatchEvent(new Event("change", { bubbles: true }));
	return true;
}

function restoreNestedSelectValue(view: ViewTarget, value: unknown, nestedState?: NestedSelectState): void {
	if (!(view instanceof Element)) return;
	const expected = toWireValue(value);
	if (sameWireValue(toWireValue(readViewValue(view)), expected)) return;
	if (nestedState && applyNestedSelectState(view, nestedState, expected)) return;
	const selects = nestedSelects(view);
	const fallback = selects.map((select) => [select, select.selectedIndex] as const);
	for (const select of selects) {
		for (let index = 0; index < select.options.length; index++) {
			// Object-valued selects store choices by identity. Dispatching the
			// nested select lets Observable Inputs restore its own option object
			// before the outer view event fires.
			select.selectedIndex = index;
			dispatchSelectEvents(select);
			if (sameWireValue(toWireValue(readViewValue(view)), expected)) return;
		}
	}
	for (const [select, selectedIndex] of fallback) {
		select.selectedIndex = selectedIndex;
		dispatchSelectEvents(select);
	}
}

function nestedSelects(view: ViewTarget): HTMLSelectElement[] {
	if (!(view instanceof Element)) return [];
	const selects = Array.from(view.querySelectorAll("select"));
	if (view instanceof HTMLSelectElement) selects.unshift(view);
	return selects;
}

function applyNestedSelectState(view: ViewTarget, state: NestedSelectState, expected: unknown): boolean {
	const selects = nestedSelects(view);
	let applied = false;
	for (let index = 0; index < state.length; index++) {
		const select = selects[index];
		const selected = state[index];
		if (!select || !selected) continue;
		const selectedIndex =
			select.options[selected.selectedIndex]?.value === selected.value
				? selected.selectedIndex
				: Array.from(select.options).findIndex((option) => option.value === selected.value);
		if (selectedIndex < 0) continue;
		select.selectedIndex = selectedIndex;
		dispatchSelectEvents(select);
		applied = true;
	}
	return applied && sameWireValue(toWireValue(readViewValue(view)), expected);
}

function dispatchSelectEvents(select: HTMLSelectElement): void {
	select.dispatchEvent(new Event("input", { bubbles: true }));
	select.dispatchEvent(new Event("change", { bubbles: true }));
}

function expectedWireValue(view: ViewTarget, value: unknown): unknown {
	if (view instanceof HTMLInputElement) {
		if (view.type === "checkbox") return toWireValue(Boolean(value));
		if (view.type === "date" && value instanceof Date) return toWireValue(value.toISOString().slice(0, 10));
		if (view.type === "datetime-local" && value instanceof Date) return toWireValue(value.toISOString().slice(0, 16));
	}
	return toWireValue(value);
}
