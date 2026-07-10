// @vitest-environment jsdom

import type { AnyModel, AnyWidget } from "@anywidget/types";
import { describe, expect, test, vi } from "vitest";
import { createAnyWidgetBundleEntry, instantiateAnyWidgetBundleApp } from "@/anywidget-bundle/entry";
import type { AnyWidgetBundleAppModule } from "@/anywidget-bundle/types";
import type { WidgetModel } from "@/widget/model";
import { createModel, initializeProps, renderProps } from "@/_tests/testing";

describe("anywidget bundle entry", () => {
	test("loads and initializes one app per model before rendering its views", async () => {
		const initialize = vi.fn(() => ({ ready: true }));
		const render = vi.fn();
		const loadApp = vi.fn((_model: AnyModel<WidgetModel>, _signal: AbortSignal) => ({
			initialize,
			render,
		}));
		const model = createModel({});
		const modelSignal = new AbortController().signal;
		const definition = await widgetDefinition(createAnyWidgetBundleEntry<WidgetModel>(loadApp));
		const initialization = initializeProps(model, modelSignal);

		await expect(definition.initialize?.(initialization)).resolves.toEqual({ ready: true });
		await definition.render?.(renderProps(model, document.createElement("div"), new AbortController().signal));
		await definition.render?.(renderProps(model, document.createElement("div"), new AbortController().signal));

		expect(loadApp).toHaveBeenCalledOnce();
		expect(loadApp).toHaveBeenCalledWith(model, modelSignal);
		expect(initialize).toHaveBeenCalledWith(initialization);
		expect(render).toHaveBeenCalledTimes(2);
	});

	test("creates an independent app instance for each model", async () => {
		const loadApp = vi.fn((_model: AnyModel<WidgetModel>, _signal: AbortSignal) => ({
			render: vi.fn(),
		}));
		const entry = createAnyWidgetBundleEntry<WidgetModel>(loadApp);
		const firstModel = createModel({});
		const secondModel = createModel({});
		const first = await widgetDefinition(entry);
		const second = await widgetDefinition(entry);

		await first.initialize?.(initializeProps(firstModel, new AbortController().signal));
		await second.initialize?.(initializeProps(secondModel, new AbortController().signal));

		expect(loadApp.mock.calls.map(([model]) => model)).toEqual([firstModel, secondModel]);
	});

	test("returns render cleanup through the host lifecycle", async () => {
		const cleanup = vi.fn();
		const definition = await widgetDefinition(
			createAnyWidgetBundleEntry<WidgetModel>(() => ({ render: () => cleanup })),
		);
		const model = createModel({});
		const signal = new AbortController().signal;
		await definition.initialize?.(initializeProps(model, signal));

		const viewCleanup = await definition.render?.(renderProps(model, document.createElement("div"), signal));

		if (typeof viewCleanup !== "function") throw new Error("Expected a view cleanup function");
		await viewCleanup();
		expect(cleanup).toHaveBeenCalledOnce();
	});

	test("returns initialization cleanup through the host lifecycle", async () => {
		const cleanup = vi.fn();
		const definition = await widgetDefinition(
			createAnyWidgetBundleEntry<WidgetModel>(() => ({ initialize: () => cleanup })),
		);
		const model = createModel({});

		const modelCleanup = await definition.initialize?.(initializeProps(model, new AbortController().signal));

		if (typeof modelCleanup !== "function") throw new Error("Expected a model cleanup function");
		await modelCleanup();
		expect(cleanup).toHaveBeenCalledOnce();
	});

	test("owns lifecycle signals when a host omits them", async () => {
		let initializeSignal: AbortSignal | undefined;
		let renderSignal: AbortSignal | undefined;
		const initializeCleanup = vi.fn();
		const renderCleanup = vi.fn();
		const model = createModel({});
		const definition = await widgetDefinition(
			createAnyWidgetBundleEntry<WidgetModel>((_model, signal) => {
				initializeSignal = signal;
				return {
					initialize(props) {
						initializeSignal = props.signal;
						return initializeCleanup;
					},
					render(props) {
						renderSignal = props.signal;
						return renderCleanup;
					},
				};
			}),
		);
		const modelCleanup = await definition.initialize?.({
			...initializeProps(model, new AbortController().signal),
			signal: undefined,
		} as unknown as Parameters<NonNullable<typeof definition.initialize>>[0]);
		const viewCleanup = await definition.render?.({
			...renderProps(model, document.createElement("div"), new AbortController().signal),
			signal: undefined,
		} as unknown as Parameters<NonNullable<typeof definition.render>>[0]);

		expect(initializeSignal?.aborted).toBe(false);
		expect(renderSignal?.aborted).toBe(false);
		if (typeof modelCleanup !== "function" || typeof viewCleanup !== "function") {
			throw new Error("Expected fallback lifecycle cleanup functions");
		}
		await viewCleanup();
		await modelCleanup();

		expect(initializeSignal?.aborted).toBe(true);
		expect(renderSignal?.aborted).toBe(true);
		expect(initializeCleanup).toHaveBeenCalledOnce();
		expect(renderCleanup).toHaveBeenCalledOnce();
	});

	test("instantiates an asynchronous app factory once", async () => {
		const render = vi.fn();
		const factory = vi.fn(async () => ({ render }));
		const definition = await widgetDefinition(createAnyWidgetBundleEntry<WidgetModel>(() => factory));
		const model = createModel({});
		const signal = new AbortController().signal;

		await definition.initialize?.(initializeProps(model, signal));
		await definition.render?.(renderProps(model, document.createElement("div"), signal));
		await definition.render?.(renderProps(model, document.createElement("div"), signal));

		expect(factory).toHaveBeenCalledOnce();
		expect(render).toHaveBeenCalledTimes(2);
	});

	test("supports an initialize-only widget definition", async () => {
		const initialize = vi.fn(() => ({ version: 1 }));
		const definition = await widgetDefinition(createAnyWidgetBundleEntry<WidgetModel>(() => ({ initialize })));
		const model = createModel({});

		await expect(definition.initialize?.(initializeProps(model, new AbortController().signal))).resolves.toEqual({
			version: 1,
		});
	});

	test("propagates app loading failures", async () => {
		const failure = new Error("chunk unavailable");
		const definition = await widgetDefinition(createAnyWidgetBundleEntry<WidgetModel>(() => Promise.reject(failure)));
		const model = createModel({});

		await expect(definition.initialize?.(initializeProps(model, new AbortController().signal))).rejects.toBe(failure);
	});

	test("propagates render failures", async () => {
		const failure = new Error("render failed");
		const definition = await widgetDefinition(
			createAnyWidgetBundleEntry<WidgetModel>(() => ({ render: () => Promise.reject(failure) })),
		);
		const model = createModel({});
		const signal = new AbortController().signal;
		await definition.initialize?.(initializeProps(model, signal));

		await expect(definition.render?.(renderProps(model, document.createElement("div"), signal))).rejects.toBe(failure);
	});

	test("skips late initialization after model cancellation", async () => {
		let resolveApp: ((app: AnyWidgetBundleAppModule<WidgetModel>) => void) | undefined;
		const initialize = vi.fn();
		const controller = new AbortController();
		const definition = await widgetDefinition(
			createAnyWidgetBundleEntry<WidgetModel>(
				() =>
					new Promise((resolve) => {
						resolveApp = resolve;
					}),
			),
		);
		const pending = definition.initialize?.(initializeProps(createModel({}), controller.signal));

		controller.abort();
		resolveApp?.({ initialize });
		await pending;

		expect(initialize).not.toHaveBeenCalled();
	});

	test.each([
		[{ render: "invalid" }, "render must be a function"],
		[{}, "must provide initialize or render"],
	])("rejects invalid widget definitions %#", async (definition, message) => {
		await expect(
			instantiateAnyWidgetBundleApp(definition as unknown as AnyWidgetBundleAppModule<WidgetModel>),
		).rejects.toThrow(message);
	});

	test("rejects rendering before model initialization", async () => {
		const definition = await widgetDefinition(createAnyWidgetBundleEntry<WidgetModel>(() => ({ render: vi.fn() })));
		const model = createModel({});

		await expect(
			definition.render?.(renderProps(model, document.createElement("div"), new AbortController().signal)),
		).rejects.toThrow("rendered before initialization");
	});
});

async function widgetDefinition(widget: AnyWidget<WidgetModel>) {
	return typeof widget === "function" ? await widget() : widget;
}
