import type { AnyModel, AnyWidget } from "@anywidget/types";
import { describe, expect, test, vi } from "vite-plus/test";
import { createAnyWidgetBundleEntry, instantiateAnyWidgetBundleApp } from "../src/entry.ts";
import type { AnyWidgetBundleAppModule } from "../src/types.ts";
import { createModel, initializeProps, renderProps, type TestState } from "./testing.ts";

describe("anywidget bundle entry", () => {
	test("loads and initializes one app per model before rendering its views", async () => {
		const initialize = vi.fn();
		const render = vi.fn();
		const loadApp = vi.fn((_model: AnyModel<TestState>, _signal: AbortSignal) => ({
			initialize,
			render,
		}));
		const model = createModel({});
		const modelSignal = new AbortController().signal;
		const definition = await widgetDefinition(createAnyWidgetBundleEntry<TestState>(loadApp));
		const initialization = initializeProps(model, modelSignal);

		const modelCleanup = definition.initialize?.(initialization);
		expect(modelCleanup).toEqual(expect.any(Function));
		await definition.render?.(renderProps(model, document.createElement("div"), new AbortController().signal));
		await definition.render?.(renderProps(model, document.createElement("div"), new AbortController().signal));

		expect(loadApp).toHaveBeenCalledOnce();
		expect(loadApp.mock.calls[0]?.[0]).toBe(model);
		expect(loadApp.mock.calls[0]?.[1].aborted).toBe(false);
		expect(initialize.mock.calls[0]?.[0].model).toBe(model);
		expect(initialize.mock.calls[0]?.[0].signal.aborted).toBe(false);
		expect(render).toHaveBeenCalledTimes(2);
		if (typeof modelCleanup === "function") await modelCleanup();
	});

	test("creates an independent app instance for each model", async () => {
		const loadApp = vi.fn((_model: AnyModel<TestState>, _signal: AbortSignal) => ({
			render: vi.fn(),
		}));
		const entry = createAnyWidgetBundleEntry<TestState>(loadApp);
		const firstModel = createModel({});
		const secondModel = createModel({});
		const first = await widgetDefinition(entry);
		const second = await widgetDefinition(entry);

		await first.initialize?.(initializeProps(firstModel, new AbortController().signal));
		await second.initialize?.(initializeProps(secondModel, new AbortController().signal));
		await vi.waitFor(() => expect(loadApp).toHaveBeenCalledTimes(2));

		expect(loadApp.mock.calls.map(([model]) => model)).toEqual([firstModel, secondModel]);
	});

	test("returns render cleanup through the host lifecycle", async () => {
		const cleanup = vi.fn();
		const definition = await widgetDefinition(createAnyWidgetBundleEntry<TestState>(() => ({ render: () => cleanup })));
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
		const initialize = vi.fn(() => cleanup);
		const definition = await widgetDefinition(createAnyWidgetBundleEntry<TestState>(() => ({ initialize })));
		const model = createModel({});

		const modelCleanup = definition.initialize?.(initializeProps(model, new AbortController().signal));
		await vi.waitFor(() => expect(initialize).toHaveBeenCalledOnce());

		if (typeof modelCleanup !== "function") throw new Error("Expected a model cleanup function");
		await modelCleanup();
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
			createAnyWidgetBundleEntry<TestState>((_model, signal) => {
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
		const modelCleanup = definition.initialize?.({
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
		const definition = await widgetDefinition(createAnyWidgetBundleEntry<TestState>(() => factory));
		const model = createModel({});
		const signal = new AbortController().signal;

		await definition.initialize?.(initializeProps(model, signal));
		await definition.render?.(renderProps(model, document.createElement("div"), signal));
		await definition.render?.(renderProps(model, document.createElement("div"), signal));

		expect(factory).toHaveBeenCalledOnce();
		expect(render).toHaveBeenCalledTimes(2);
	});

	test("settles outer initialization while app loading is pending", async () => {
		let resolveApp: ((app: AnyWidgetBundleAppModule<TestState>) => void) | undefined;
		const initialize = vi.fn();
		const render = vi.fn();
		const definition = await widgetDefinition(
			createAnyWidgetBundleEntry<TestState>(
				() =>
					new Promise((resolve) => {
						resolveApp = resolve;
					}),
			),
		);
		const model = createModel({});

		const modelCleanup = definition.initialize?.(initializeProps(model, new AbortController().signal));
		expect(modelCleanup).toEqual(expect.any(Function));
		expect(initialize).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(resolveApp).toEqual(expect.any(Function)));
		resolveApp?.({ initialize, render });
		await definition.render?.(renderProps(model, document.createElement("div"), new AbortController().signal));

		expect(initialize).toHaveBeenCalledOnce();
		expect(render).toHaveBeenCalledOnce();
	});

	test("propagates app loading failures", async () => {
		const failure = new Error("chunk unavailable");
		const definition = await widgetDefinition(createAnyWidgetBundleEntry<TestState>(() => Promise.reject(failure)));
		const model = createModel({});
		const signal = new AbortController().signal;

		await definition.initialize?.(initializeProps(model, signal));
		await expect(definition.render?.(renderProps(model, document.createElement("div"), signal))).rejects.toBe(failure);
	});

	test("rejects object-valued initialization exports before rendering", async () => {
		const render = vi.fn();
		const app = {
			initialize: () => ({ ready: true }),
			render,
		} as unknown as AnyWidgetBundleAppModule<TestState>;
		const definition = await widgetDefinition(createAnyWidgetBundleEntry<TestState>(() => app));
		const model = createModel({});
		const signal = new AbortController().signal;

		await definition.initialize?.(initializeProps(model, signal));
		await expect(definition.render?.(renderProps(model, document.createElement("div"), signal))).rejects.toThrow(
			"initialize must return a cleanup function or nothing",
		);
		expect(render).not.toHaveBeenCalled();
	});

	test("propagates render failures", async () => {
		const failure = new Error("render failed");
		const definition = await widgetDefinition(
			createAnyWidgetBundleEntry<TestState>(() => ({ render: () => Promise.reject(failure) })),
		);
		const model = createModel({});
		const signal = new AbortController().signal;
		await definition.initialize?.(initializeProps(model, signal));

		await expect(definition.render?.(renderProps(model, document.createElement("div"), signal))).rejects.toBe(failure);
	});

	test("skips late initialization after model cancellation", async () => {
		let resolveApp: ((app: AnyWidgetBundleAppModule<TestState>) => void) | undefined;
		const initialize = vi.fn();
		const controller = new AbortController();
		const definition = await widgetDefinition(
			createAnyWidgetBundleEntry<TestState>(
				() =>
					new Promise((resolve) => {
						resolveApp = resolve;
					}),
			),
		);
		const modelCleanup = definition.initialize?.(initializeProps(createModel({}), controller.signal));

		controller.abort();
		await vi.waitFor(() => expect(resolveApp).toEqual(expect.any(Function)));
		resolveApp?.({ initialize });
		if (typeof modelCleanup === "function") await modelCleanup();

		expect(initialize).not.toHaveBeenCalled();
	});

	test("runs late initialization cleanup once when model teardown wins", async () => {
		let resolveInitialize: ((cleanup: () => void) => void) | undefined;
		const cleanup = vi.fn();
		const initialize = vi.fn(
			() =>
				new Promise<() => void>((resolve) => {
					resolveInitialize = resolve;
				}),
		);
		const definition = await widgetDefinition(createAnyWidgetBundleEntry<TestState>(() => ({ initialize })));
		const modelCleanup = definition.initialize?.(initializeProps(createModel({}), new AbortController().signal));
		await vi.waitFor(() => expect(initialize).toHaveBeenCalledOnce());

		if (typeof modelCleanup !== "function") throw new Error("Expected a model cleanup function");
		const disposal = modelCleanup();
		resolveInitialize?.(cleanup);
		await disposal;
		await modelCleanup();

		expect(cleanup).toHaveBeenCalledOnce();
	});

	test("does not render after model teardown", async () => {
		let resolveApp: ((app: AnyWidgetBundleAppModule<TestState>) => void) | undefined;
		const render = vi.fn();
		const definition = await widgetDefinition(
			createAnyWidgetBundleEntry<TestState>(
				() =>
					new Promise((resolve) => {
						resolveApp = resolve;
					}),
			),
		);
		const model = createModel({});
		const modelCleanup = definition.initialize?.(initializeProps(model, new AbortController().signal));
		await vi.waitFor(() => expect(resolveApp).toEqual(expect.any(Function)));
		const rendering = definition.render?.(
			renderProps(model, document.createElement("div"), new AbortController().signal),
		);

		if (typeof modelCleanup !== "function") throw new Error("Expected a model cleanup function");
		const disposal = modelCleanup();
		resolveApp?.({ render });
		await Promise.all([rendering, disposal]);

		expect(render).not.toHaveBeenCalled();
	});

	test.each([
		[{ render: "invalid" }, "render must be a function"],
		[{}, "must provide initialize or render"],
	])("rejects invalid widget definitions %#", async (definition, message) => {
		await expect(
			instantiateAnyWidgetBundleApp(definition as unknown as AnyWidgetBundleAppModule<TestState>),
		).rejects.toThrow(message);
	});

	test("rejects rendering before model initialization", async () => {
		const definition = await widgetDefinition(createAnyWidgetBundleEntry<TestState>(() => ({ render: vi.fn() })));
		const model = createModel({});

		await expect(
			definition.render?.(renderProps(model, document.createElement("div"), new AbortController().signal)),
		).rejects.toThrow("rendered before initialization");
	});
});

async function widgetDefinition(widget: AnyWidget<TestState>) {
	return typeof widget === "function" ? await widget() : widget;
}
