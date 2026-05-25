import type { ViewTarget } from "./types";

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

export function writeViewValue(view: ViewTarget, value: unknown): void {
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
	}
	view.dispatchEvent(new Event("input", { bubbles: true }));
	view.dispatchEvent(new Event("change", { bubbles: true }));
}
