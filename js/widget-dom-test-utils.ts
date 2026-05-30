import type { RenderProps } from "@anywidget/types";
import { expect } from "vitest";
import { SELECTORS } from "./widget/dom-contract";
import type { WidgetModel } from "./widget/types";
import widget from "./widget";
import {
	createCellExportsMap,
	createHost,
	createModel,
	objectValuedSelectSource,
	renderChildrenThroughWidget,
	variableValue,
	waitFor,
} from "./widget-test-utils";

export async function mountPresetDisplayNotebook(controller: AbortController): Promise<{
	parentEl: HTMLDivElement;
	firstStandaloneEl: HTMLDivElement;
	secondStandaloneEl: HTMLDivElement;
	parentSelect: HTMLSelectElement;
	standaloneSelect: HTMLSelectElement;
	presetsModel: ReturnType<typeof createModel>;
}> {
	const model = createModel({
		role: "notebook",
		source: `
<notebook>
  <script id="1" type="application/vnd.observable.javascript">${objectValuedSelectSource}</script>
  <script id="2" type="application/vnd.observable.javascript">presetsArray = [{pointDensity: 7}, {pointDensity: 21}]</script>
  <script id="3" type="application/vnd.observable.javascript">viewof presets = Select(presetsArray, {value: presetsArray[0]})</script>
  <script id="4" type="application/vnd.observable.javascript">
display = {
  const node = document.createElement("output");
  node.textContent = String(presets.pointDensity);
  return node;
}
  </script>
</notebook>
`,
		attachments: {},
		_variables: {},
		options: {},
		_cell_widgets: ["anywidget:select", "anywidget:presets-array", "anywidget:presets", "anywidget:display"],
	});
	const selectModel = createModel({ role: "cell", name: "select", _values: {}, _value_names: [] });
	const presetsArrayModel = createModel({ role: "cell", name: "presetsArray", _values: {}, _value_names: [] });
	const presetsModel = createModel({ role: "cell", name: "presets", _values: {}, _value_names: [] });
	const displayModel = createModel({ role: "cell", name: "display", _values: {}, _value_names: [] });
	const childModels = new Map([
		["anywidget:select", selectModel],
		["anywidget:presets-array", presetsArrayModel],
		["anywidget:presets", presetsModel],
		["anywidget:display", displayModel],
	]);
	const childExports = createCellExportsMap(childModels);
	const childRenders = renderChildrenThroughWidget(childModels);
	const parentEl = document.createElement("div");
	const standalonePresetsEl = document.createElement("div");
	const firstStandaloneEl = document.createElement("div");
	const secondStandaloneEl = document.createElement("div");

	widget.render({
		model,
		el: parentEl,
		signal: controller.signal,
		host: createHost(childModels, childExports, childRenders),
	} as unknown as RenderProps<WidgetModel>);
	widget.render({
		model: presetsModel,
		el: standalonePresetsEl,
		signal: controller.signal,
		host: createHost(new Map()),
	} as unknown as RenderProps<WidgetModel>);
	for (const el of [firstStandaloneEl, secondStandaloneEl]) {
		widget.render({
			model: displayModel,
			el,
			signal: controller.signal,
			host: createHost(new Map()),
		} as unknown as RenderProps<WidgetModel>);
	}

	return {
		parentEl,
		firstStandaloneEl,
		secondStandaloneEl,
		parentSelect: await waitStep("parent select", () => onlySelect(parentEl)),
		standaloneSelect: await waitStep("standalone select", () => onlySelect(standalonePresetsEl)),
		presetsModel,
	};
}

export async function waitStep<T>(label: string, read: () => T | undefined, timeoutMs?: number): Promise<T> {
	try {
		return await waitFor(read, timeoutMs);
	} catch (error) {
		throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function presetPointDensity(model: ReturnType<typeof createModel>, value: number): unknown | undefined {
	const preset = variableValue(model, "presets");
	return preset && typeof preset === "object" && (preset as { pointDensity?: unknown }).pointDensity === value
		? preset
		: undefined;
}

export function standaloneText(el: HTMLElement, value: string): HTMLElement | undefined {
	const cells = Array.from(el.querySelectorAll<HTMLElement>(SELECTORS.standaloneCell));
	if (cells.length === 0) return undefined;
	if (cells.length > 1) throw new Error(`Expected one standalone cell, found ${cells.length}`);
	const [cell] = cells;
	const text = cell?.textContent?.trim() ?? "";
	if (text !== value) return undefined;
	return cell;
}

export function standaloneInspectorText(el: HTMLElement, value: string): HTMLElement | undefined {
	const cells = Array.from(el.querySelectorAll<HTMLElement>(SELECTORS.standaloneCell));
	if (cells.length === 0) return undefined;
	if (cells.length > 1) throw new Error(`Expected one standalone cell, found ${cells.length}`);
	const [cell] = cells;
	const text = cell?.textContent?.trim() ?? "";
	if (text !== value && text !== `"${value}"`) return undefined;
	return cell;
}

export function composedText(el: HTMLElement, value: string): HTMLElement | undefined {
	const cells = Array.from(el.querySelectorAll<HTMLElement>(SELECTORS.composedCell));
	if (cells.length === 0) return undefined;
	const matches = cells.filter((cell) => (cell.textContent?.trim() ?? "") === value);
	if (matches.length === 0) return undefined;
	if (matches.length > 1) throw new Error(`Expected one composed cell with ${value}, found ${matches.length}`);
	return matches[0]!;
}

export function composedInspectorText(el: HTMLElement, value: string): HTMLElement | undefined {
	const cells = Array.from(el.querySelectorAll<HTMLElement>(SELECTORS.composedCell));
	if (cells.length === 0) return undefined;
	const matches = cells.filter((cell) => {
		const text = cell.textContent?.trim() ?? "";
		return text === value || text === `"${value}"`;
	});
	if (matches.length === 0) return undefined;
	if (matches.length > 1) throw new Error(`Expected one composed cell with ${value}, found ${matches.length}`);
	return matches[0]!;
}

export function onlyInput(el: HTMLElement): HTMLInputElement {
	const inputs = Array.from(el.querySelectorAll<HTMLInputElement>("input"));
	if (inputs.length !== 1) throw new Error(`Expected one input, found ${inputs.length}`);
	return inputs[0]!;
}

export function inputWithValue(el: HTMLElement, value: string): HTMLInputElement | undefined {
	const inputs = Array.from(el.querySelectorAll<HTMLInputElement>("input"));
	if (inputs.length === 0) return undefined;
	if (inputs.length > 1) throw new Error(`Expected one input, found ${inputs.length}`);
	const [input] = inputs;
	return input?.value === value ? input : undefined;
}

export function rangeWithNumber(el: HTMLElement, value: number): HTMLInputElement | undefined {
	const inputs = Array.from(el.querySelectorAll<HTMLInputElement>("input[type='range']"));
	if (inputs.length === 0) return undefined;
	if (inputs.length > 1) throw new Error(`Expected one range input, found ${inputs.length}`);
	const [input] = inputs;
	return input?.valueAsNumber === value ? input : undefined;
}

export function onlySelect(el: HTMLElement): HTMLSelectElement | undefined {
	const selects = Array.from(el.querySelectorAll<HTMLSelectElement>("select"));
	if (selects.length === 0) return undefined;
	if (selects.length > 1) throw new Error(`Expected one select, found ${selects.length}`);
	return selects[0]!;
}

export function onlyCanvas(el: HTMLElement): HTMLCanvasElement | undefined {
	const canvases = Array.from(el.querySelectorAll<HTMLCanvasElement>("canvas"));
	if (canvases.length === 0) return undefined;
	if (canvases.length > 1) throw new Error(`Expected one canvas, found ${canvases.length}`);
	return canvases[0]!;
}

export function onlyButton(el: HTMLElement): HTMLButtonElement | undefined {
	const buttons = Array.from(el.querySelectorAll<HTMLButtonElement>("button"));
	if (buttons.length === 0) return undefined;
	if (buttons.length > 1) throw new Error(`Expected one button, found ${buttons.length}`);
	return buttons[0]!;
}

export function expectCanvasOutputOnly(el: HTMLElement): void {
	const outputs = Array.from(el.querySelectorAll(SELECTORS.standaloneCell));
	expect(outputs).toHaveLength(1);
	const [output] = outputs;
	const canvases = Array.from(output?.querySelectorAll("canvas") ?? []);
	expect(canvases).toHaveLength(1);
	expect(output?.querySelector(SELECTORS.error)).toBeNull();
}

export function displayForPointDensity(el: HTMLElement, value: number): HTMLOutputElement | undefined {
	const error = el.querySelector(SELECTORS.error)?.textContent;
	if (error) throw new Error(error);
	const outputs = Array.from(el.querySelectorAll<HTMLOutputElement>("output"));
	if (outputs.length === 0) return undefined;
	if (outputs.length > 1) throw new Error(`Expected one output, found ${outputs.length}`);
	const [output] = outputs;
	return output?.textContent?.trim() === String(value) ? output : undefined;
}

export function projectErrorText(el: HTMLElement): string | undefined {
	const errors = Array.from(el.querySelectorAll<HTMLElement>(SELECTORS.error));
	if (errors.length === 0) return undefined;
	if (errors.length > 1) throw new Error(`Expected one error output, found ${errors.length}`);
	const text = errors[0]?.textContent?.trim() ?? "";
	return text || undefined;
}

export function chooseOption(select: HTMLSelectElement, index: number): void {
	select.selectedIndex = index;
	select.dispatchEvent(new Event("input", { bubbles: true }));
	select.dispatchEvent(new Event("change", { bubbles: true }));
	const view = select.closest("form");
	view?.dispatchEvent(new Event("input", { bubbles: true }));
	view?.dispatchEvent(new Event("change", { bubbles: true }));
}

export async function flushStandaloneInvalidations(): Promise<void> {
	await new Promise<void>((resolve) => queueMicrotask(resolve));
}
