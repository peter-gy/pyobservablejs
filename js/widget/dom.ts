import type { Cell, Notebook } from "@observablehq/notebook-kit";
import { CLASS_NAMES, DATASET_KEYS } from "./dom-contract";

export function markWidgetShell(el: HTMLElement): void {
	el.classList.add(CLASS_NAMES.widget);
}

export function prepareWidgetShell(el: HTMLElement): void {
	el.replaceChildren();
	markWidgetShell(el);
}

export function createNotebookRoot(parent: HTMLElement, theme: Notebook["theme"]): HTMLElement {
	const root = document.createElement("div");
	root.className = `${CLASS_NAMES.notebook} observablehq observablehq--block`;
	root.dataset.theme = typeof theme === "string" ? theme : "light-dark";
	parent.appendChild(root);
	return root;
}

export function appendCellWrapper(
	root: HTMLElement,
	options: { composedCellRef?: string; standalone?: boolean } = {},
): HTMLElement {
	const wrapper = document.createElement("div");
	wrapper.className = CLASS_NAMES.cell;
	if (options.composedCellRef !== undefined) {
		wrapper.dataset[DATASET_KEYS.composed] = "true";
		wrapper.dataset[DATASET_KEYS.cellRef] = options.composedCellRef;
	}
	if (options.standalone) {
		wrapper.dataset[DATASET_KEYS.standaloneCell] = "true";
	}
	root.appendChild(wrapper);
	return wrapper;
}

export function createCellOutput(wrapper: HTMLElement, cell: Cell): HTMLDivElement {
	const output = document.createElement("div");
	output.id = `cell-${cell.id}`;
	output.className = "observablehq observablehq--cell";
	wrapper.appendChild(output);
	return output;
}

export function createTopLevelError(error: unknown): HTMLElement {
	const pre = document.createElement("pre");
	pre.className = CLASS_NAMES.error;
	pre.textContent = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	return pre;
}
