import type { RenderProps } from "@anywidget/types";
import type { WidgetModel } from "./model";

// Parent and cell models load separate module graphs. Symbol.for keeps the DOM
// handoff stable across those graphs and parent HMR generations.
const PROJECTION_CONTEXT = Symbol.for("@pyobservablejs/widget/cell-projection/v1");
const PROJECTION_BRAND = "pyobservablejs-cell-projection";

export type CellProjectionContext = {
	brand: typeof PROJECTION_BRAND;
	version: 1;
	index: number;
	cellModel: RenderProps<WidgetModel>["model"];
};

export function installCellProjectionContext(
	el: HTMLElement,
	cellModel: RenderProps<WidgetModel>["model"],
	index: number,
	signal: AbortSignal,
): CellProjectionContext {
	const context: CellProjectionContext = {
		brand: PROJECTION_BRAND,
		version: 1,
		index,
		cellModel,
	};
	Reflect.set(el, PROJECTION_CONTEXT, context);
	const clear = () => {
		// A replacement projection may reuse this element before the old view aborts.
		if (Reflect.get(el, PROJECTION_CONTEXT) === context) Reflect.deleteProperty(el, PROJECTION_CONTEXT);
	};
	signal.addEventListener("abort", clear, { once: true });
	return context;
}

export function readCellProjectionContext(el: HTMLElement): CellProjectionContext | undefined {
	const value = Reflect.get(el, PROJECTION_CONTEXT) as Partial<CellProjectionContext> | undefined;
	if (
		value?.brand !== PROJECTION_BRAND ||
		value.version !== 1 ||
		!Number.isInteger(value.index) ||
		(value.index as number) < 0 ||
		value.cellModel === null ||
		typeof value.cellModel !== "object"
	) {
		return undefined;
	}
	return value as CellProjectionContext;
}
