import { sameValue, type RuntimeValue } from "./values";

export type ViewTarget = EventTarget & {
	value?: RuntimeValue;
	checked?: boolean;
};

export type RuntimeVariablesSync = {
	applyInitialViews(): void;
	setView(name: string, view: ViewTarget, options?: { applyInitialVariable?: boolean }): void;
	deleteView(name: string, view: ViewTarget): void;
};

export type ViewWriteResult = "applied" | "unsupported";

export function isViewTarget<Value>(value: Value): value is Value & ViewTarget {
	return value instanceof EventTarget && "value" in value;
}

export function readViewValue(view: ViewTarget): RuntimeValue {
	if (view instanceof HTMLInputElement) {
		if (view.type === "checkbox") return view.checked;
		if (view.type === "number" || view.type === "range") return view.valueAsNumber;
		if (view.type === "date") return view.valueAsDate;
		if (view.type === "file") return view.multiple ? view.files : view.files?.[0];
		return view.value;
	}
	if (view instanceof HTMLSelectElement && view.multiple) {
		return Array.from(view.selectedOptions, (option) => option.value);
	}
	return view.value;
}

export function writeViewValue(view: ViewTarget, value: RuntimeValue): ViewWriteResult {
	if (view instanceof HTMLInputElement && view.type === "file") return "unsupported";
	const expected = expectedValue(view, value);
	if (view instanceof HTMLInputElement) {
		if (view.type === "checkbox") {
			view.checked = Boolean(value);
			view.value = String(value);
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
	const read = () => (view instanceof HTMLInputElement && view.type === "date" ? view.value : readViewValue(view));
	if (!sameValue(read(), expected)) return "unsupported";
	if (isClickInput(view)) view.dispatchEvent(new Event("click", { bubbles: true }));
	view.dispatchEvent(new Event("input", { bubbles: true }));
	view.dispatchEvent(new Event("change", { bubbles: true }));
	return sameValue(read(), expected) ? "applied" : "unsupported";
}

export function isClickInput(view: ViewTarget): boolean {
	return (
		(view instanceof HTMLInputElement || view instanceof HTMLButtonElement) &&
		(view.type === "button" || view.type === "submit" || view.type === "checkbox")
	);
}

function restoreNestedSelectValue(view: ViewTarget, value: RuntimeValue): void {
	if (!(view instanceof Element)) return;
	if (sameValue(readViewValue(view), value)) return;
	const selects = nestedSelects(view);
	const fallback = selects.map((select) => [select, select.selectedIndex] as const);
	for (const select of selects) {
		for (let index = 0; index < select.options.length; index++) {
			// Object-valued selects store choices by identity. Let Observable Inputs
			// restore its option object before the outer view event runs.
			select.selectedIndex = index;
			dispatchSelectEvents(select);
			if (sameValue(readViewValue(view), value)) return;
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

function expectedValue(view: ViewTarget, value: RuntimeValue): RuntimeValue {
	if (view instanceof HTMLInputElement) {
		if (view.type === "checkbox") return Boolean(value);
		if (view.type === "date") {
			if (isValidDate(value)) return value.toISOString().slice(0, 10);
			if (value == null) return "";
		}
		if (view.type === "datetime-local" && isValidDate(value)) return value.toISOString().slice(0, 16);
	}
	return value;
}

function isValidDate<Value>(value: Value): value is Value & Date {
	return value instanceof Date && Number.isFinite(value.getTime());
}
