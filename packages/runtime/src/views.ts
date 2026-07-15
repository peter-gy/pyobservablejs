import { sameWireValue, toWireValue } from "./values";

export type ViewTarget = EventTarget & {
	value?: unknown;
	checked?: boolean;
};

export type RuntimeVariablesSync = {
	applyInitialViews(): void;
	setView(name: string, view: ViewTarget, options?: { applyInitialVariable?: boolean }): void;
	deleteView(name: string, view: ViewTarget): void;
};

export type ViewWriteResult = "applied" | "unsupported";

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

export function writeViewValue(view: ViewTarget, value: unknown): ViewWriteResult {
	const expected = expectedWireValue(view, value);
	if (view instanceof HTMLInputElement) {
		if (view.type === "checkbox") {
			view.checked = Boolean(value);
			view.value = String(value);
			view.dispatchEvent(new Event("click", { bubbles: true }));
		} else if (view.type === "date" && isValidDate(value)) {
			view.value = value.toISOString().slice(0, 10);
		} else if (view.type === "datetime-local" && isValidDate(value)) {
			view.value = value.toISOString().slice(0, 16);
		} else {
			view.value = value == null ? "" : String(value);
		}
	} else if (view instanceof HTMLSelectElement && view.multiple && Array.isArray(value)) {
		const selected = new Set(value.map(String));
		for (const option of view.options) option.selected = selected.has(option.value);
	} else {
		view.value = value;
		restoreNestedSelectValue(view, value);
	}
	if (!sameWireValue(toWireValue(readViewValue(view)), expected)) return "unsupported";
	view.dispatchEvent(new Event("input", { bubbles: true }));
	view.dispatchEvent(new Event("change", { bubbles: true }));
	return "applied";
}

function restoreNestedSelectValue(view: ViewTarget, value: unknown): void {
	if (!(view instanceof Element)) return;
	const expected = toWireValue(value);
	if (sameWireValue(toWireValue(readViewValue(view)), expected)) return;
	const selects = nestedSelects(view);
	const fallback = selects.map((select) => [select, select.selectedIndex] as const);
	for (const select of selects) {
		for (let index = 0; index < select.options.length; index++) {
			// Object-valued selects store choices by identity. Let Observable Inputs
			// restore its option object before the outer view event runs.
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

function dispatchSelectEvents(select: HTMLSelectElement): void {
	select.dispatchEvent(new Event("input", { bubbles: true }));
	select.dispatchEvent(new Event("change", { bubbles: true }));
}

function expectedWireValue(view: ViewTarget, value: unknown): unknown {
	if (view instanceof HTMLInputElement) {
		if (view.type === "checkbox") return toWireValue(Boolean(value));
		if (view.type === "date" && isValidDate(value)) return toWireValue(value.toISOString().slice(0, 10));
		if (view.type === "datetime-local" && isValidDate(value)) return toWireValue(value.toISOString().slice(0, 16));
	}
	return toWireValue(value);
}

function isValidDate(value: unknown): value is Date {
	return value instanceof Date && Number.isFinite(value.getTime());
}
