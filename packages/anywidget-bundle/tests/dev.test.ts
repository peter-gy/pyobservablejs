import type { AnyWidget, InitializeProps, RenderProps } from "@anywidget/types";
import { describe, expect, test, vi } from "vite-plus/test";
import { createAnyWidgetBundleDevelopmentEntry } from "../src/dev.ts";
import { createModel, initializeProps, renderProps, type TestState } from "./testing.ts";

describe("anywidget bundle development entry", () => {
	test("instantiates factories per model and preserves lifecycle props", async () => {
		const initialize = vi.fn((_props: InitializeProps<TestState>) => undefined);
		const render = vi.fn((props: RenderProps<TestState>) => {
			props.el.textContent = "ready";
		});
		const factory = vi.fn(async () => ({ initialize, render }));
		const entry = createAnyWidgetBundleDevelopmentEntry<TestState>(factory);
		const firstModel = createModel({});
		const secondModel = createModel({});
		const first = await widgetDefinition(entry.widget);
		const second = await widgetDefinition(entry.widget);
		const firstInitialization = initializeProps(firstModel, new AbortController().signal);
		const secondInitialization = initializeProps(secondModel, new AbortController().signal);

		await first.initialize?.(firstInitialization);
		await second.initialize?.(secondInitialization);
		const view = renderProps(firstModel, document.createElement("div"), new AbortController().signal);
		await first.render?.(view);

		expect(factory).toHaveBeenCalledTimes(2);
		expect(initialize.mock.calls[0]?.[0].experimental).toBe(firstInitialization.experimental);
		expect(render.mock.calls[0]?.[0].experimental).toBe(view.experimental);
		expect(render.mock.calls[0]?.[0].host).toBe(view.host);
		expect(view.el.textContent).toBe("ready");
		await entry.dispose();
	});

	test("owns lifecycle signals when a host omits them", async () => {
		let initializeSignal: AbortSignal | undefined;
		let renderSignal: AbortSignal | undefined;
		const initializeCleanup = vi.fn();
		const renderCleanup = vi.fn();
		const entry = createAnyWidgetBundleDevelopmentEntry<TestState>({
			initialize(props) {
				initializeSignal = props.signal;
				return initializeCleanup;
			},
			render(props) {
				renderSignal = props.signal;
				return renderCleanup;
			},
		});
		const definition = await widgetDefinition(entry.widget);
		const model = createModel({});
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
		await entry.dispose();

		expect(initializeSignal?.aborted).toBe(true);
		expect(renderSignal?.aborted).toBe(true);
		expect(initializeCleanup).toHaveBeenCalledOnce();
		expect(renderCleanup).toHaveBeenCalledOnce();
		if (typeof modelCleanup !== "function" || typeof viewCleanup !== "function") {
			throw new Error("Expected fallback lifecycle cleanup functions");
		}
		await viewCleanup();
		await modelCleanup();
		expect(initializeCleanup).toHaveBeenCalledOnce();
		expect(renderCleanup).toHaveBeenCalledOnce();
	});

	test("restarts active models and views when the app updates", async () => {
		const firstInitializeCleanup = vi.fn();
		const firstRenderCleanup = vi.fn();
		const secondInitializeCleanup = vi.fn();
		const secondRenderCleanup = vi.fn();
		const firstRender = vi.fn(({ el }: RenderProps<TestState>) => {
			el.textContent = "first";
			return firstRenderCleanup;
		});
		const secondRender = vi.fn(({ el }: RenderProps<TestState>) => {
			el.textContent = "second";
			return secondRenderCleanup;
		});
		const entry = createAnyWidgetBundleDevelopmentEntry<TestState>({
			initialize: () => firstInitializeCleanup,
			render: firstRender,
		});
		const definition = await widgetDefinition(entry.widget);
		const model = createModel({});
		const modelController = new AbortController();
		const viewController = new AbortController();
		const el = document.createElement("div");
		const modelCleanup = await definition.initialize?.(initializeProps(model, modelController.signal));
		const viewCleanup = await definition.render?.(renderProps(model, el, viewController.signal));

		await entry.update({ initialize: () => secondInitializeCleanup, render: secondRender });

		expect(firstInitializeCleanup).toHaveBeenCalledOnce();
		expect(firstRenderCleanup).toHaveBeenCalledOnce();
		expect(secondRender).toHaveBeenCalledOnce();
		expect(el.textContent).toBe("second");

		if (typeof viewCleanup !== "function" || typeof modelCleanup !== "function") {
			throw new Error("Expected development lifecycle cleanup functions");
		}
		await viewCleanup();
		await modelCleanup();
		expect(secondRenderCleanup).toHaveBeenCalledOnce();
		expect(secondInitializeCleanup).toHaveBeenCalledOnce();
	});

	test("removes scoped model listeners before hot-update cleanup runs", async () => {
		const initializeModel = createModel({});
		const viewModel = createModel({});
		const initializeListener = vi.fn();
		const viewListener = vi.fn();
		const initializeCleanup = vi.fn(() => initializeModel.set("_source", "cleaned"));
		const viewCleanup = vi.fn(() => viewModel.set("_source", "cleaned"));
		const entry = createAnyWidgetBundleDevelopmentEntry<TestState>({
			initialize({ model }) {
				model.on("change:_source", initializeListener);
				return initializeCleanup;
			},
			render({ model }) {
				model.on("change:_source", viewListener);
				return viewCleanup;
			},
		});
		const definition = await widgetDefinition(entry.widget);
		await definition.initialize?.(initializeProps(initializeModel, new AbortController().signal));
		await definition.render?.(renderProps(viewModel, document.createElement("div"), new AbortController().signal));

		await entry.update({ initialize: vi.fn(), render: vi.fn() });

		expect(viewCleanup).toHaveBeenCalledOnce();
		expect(initializeCleanup).toHaveBeenCalledOnce();
		expect(viewListener).not.toHaveBeenCalled();
		expect(initializeListener).not.toHaveBeenCalled();
		await entry.dispose();
	});

	test("removes an aborted model before later updates", async () => {
		const firstCleanup = vi.fn();
		const nextInitialize = vi.fn();
		const entry = createAnyWidgetBundleDevelopmentEntry<TestState>({
			initialize: () => firstCleanup,
		});
		const definition = await widgetDefinition(entry.widget);
		const controller = new AbortController();
		await definition.initialize?.(initializeProps(createModel({}), controller.signal));

		controller.abort();
		await entry.update({ initialize: nextInitialize });

		expect(firstCleanup).toHaveBeenCalledOnce();
		expect(nextInitialize).not.toHaveBeenCalled();
	});

	test("disposes active models and views once and excludes them from later updates", async () => {
		const initializeCleanup = vi.fn();
		const renderCleanup = vi.fn();
		const nextInitialize = vi.fn();
		const entry = createAnyWidgetBundleDevelopmentEntry<TestState>({
			initialize: () => initializeCleanup,
			render: () => renderCleanup,
		});
		const definition = await widgetDefinition(entry.widget);
		const modelController = new AbortController();
		const viewController = new AbortController();
		const model = createModel({});
		const modelCleanup = await definition.initialize?.(initializeProps(model, modelController.signal));
		const viewCleanup = await definition.render?.(
			renderProps(model, document.createElement("div"), viewController.signal),
		);

		await entry.dispose();
		await entry.update({ initialize: nextInitialize });

		expect(initializeCleanup).toHaveBeenCalledOnce();
		expect(renderCleanup).toHaveBeenCalledOnce();
		expect(nextInitialize).not.toHaveBeenCalled();

		if (typeof viewCleanup !== "function" || typeof modelCleanup !== "function") {
			throw new Error("Expected development lifecycle cleanup functions");
		}
		await viewCleanup();
		await modelCleanup();
		modelController.abort();
		viewController.abort();

		expect(initializeCleanup).toHaveBeenCalledOnce();
		expect(renderCleanup).toHaveBeenCalledOnce();
	});

	test("waits for delayed initialization before final listener cleanup", async () => {
		let releaseInitialize!: () => void;
		let disposalSettled = false;
		const listener = vi.fn();
		const cleanup = vi.fn();
		const initialize = vi.fn(async ({ model }: InitializeProps<TestState>) => {
			await new Promise<void>((resolve) => {
				releaseInitialize = resolve;
			});
			model.on("change:_source", listener);
			return cleanup;
		});
		const entry = createAnyWidgetBundleDevelopmentEntry<TestState>({ initialize });
		const definition = await widgetDefinition(entry.widget);
		const model = createModel({});
		const initialization = definition.initialize?.(initializeProps(model, new AbortController().signal));
		await vi.waitFor(() => expect(initialize).toHaveBeenCalledOnce());

		const disposal = entry.dispose().then(() => {
			disposalSettled = true;
		});
		const repeatedDisposal = entry.dispose();
		await Promise.resolve();
		expect(disposalSettled).toBe(false);
		releaseInitialize();
		await Promise.all([initialization, disposal, repeatedDisposal]);

		model.set("_source", "after-disposal");
		expect(listener).not.toHaveBeenCalled();
		expect(cleanup).toHaveBeenCalledOnce();
	});

	test("waits for delayed render before final listener cleanup", async () => {
		let releaseRender!: () => void;
		let disposalSettled = false;
		const listener = vi.fn();
		const cleanup = vi.fn();
		const render = vi.fn(async ({ model }: RenderProps<TestState>) => {
			await new Promise<void>((resolve) => {
				releaseRender = resolve;
			});
			model.on("change:_source", listener);
			return cleanup;
		});
		const entry = createAnyWidgetBundleDevelopmentEntry<TestState>({ render });
		const definition = await widgetDefinition(entry.widget);
		const model = createModel({});
		await definition.initialize?.(initializeProps(model, new AbortController().signal));
		const rendering = definition.render?.(
			renderProps(model, document.createElement("div"), new AbortController().signal),
		);
		await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());

		const disposal = entry.dispose().then(() => {
			disposalSettled = true;
		});
		await Promise.resolve();
		expect(disposalSettled).toBe(false);
		releaseRender();
		await Promise.all([rendering, disposal]);

		model.set("_source", "after-disposal");
		expect(listener).not.toHaveBeenCalled();
		expect(cleanup).toHaveBeenCalledOnce();
	});

	test("runs initialization cleanup once when model abort races an update", async () => {
		let releaseCleanup!: () => void;
		const initializeCleanup = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					releaseCleanup = resolve;
				}),
		);
		const entry = createAnyWidgetBundleDevelopmentEntry<TestState>({
			initialize: () => initializeCleanup,
		});
		const definition = await widgetDefinition(entry.widget);
		const modelController = new AbortController();
		await definition.initialize?.(initializeProps(createModel({}), modelController.signal));

		const update = entry.update({ initialize: vi.fn() });
		await vi.waitFor(() => expect(initializeCleanup).toHaveBeenCalledOnce());
		modelController.abort();
		releaseCleanup();
		await update;

		expect(initializeCleanup).toHaveBeenCalledOnce();
	});

	test("settles cleanup failures after an abort", async () => {
		const cleanup = vi.fn(async () => {
			throw new Error("cleanup failed");
		});
		const entry = createAnyWidgetBundleDevelopmentEntry<TestState>({ initialize: () => cleanup });
		const definition = await widgetDefinition(entry.widget);
		const controller = new AbortController();
		await definition.initialize?.(initializeProps(createModel({}), controller.signal));

		controller.abort();
		await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
	});

	test("runs initialization cleanup when a view cleanup rejects", async () => {
		const initializeCleanup = vi.fn();
		const renderCleanup = vi.fn(async () => {
			throw new Error("render cleanup failed");
		});
		const entry = createAnyWidgetBundleDevelopmentEntry<TestState>({
			initialize: () => initializeCleanup,
			render: () => renderCleanup,
		});
		const definition = await widgetDefinition(entry.widget);
		const model = createModel({});
		await definition.initialize?.(initializeProps(model, new AbortController().signal));
		await definition.render?.(renderProps(model, document.createElement("div"), new AbortController().signal));

		await expect(entry.dispose()).rejects.toThrow("render cleanup failed");

		expect(renderCleanup).toHaveBeenCalledOnce();
		expect(initializeCleanup).toHaveBeenCalledOnce();
	});

	test("waits for every model cleanup before surfacing a failure", async () => {
		let releaseCleanup!: () => void;
		const firstCleanup = vi.fn(async () => {
			throw new Error("first cleanup failed");
		});
		const secondCleanup = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					releaseCleanup = resolve;
				}),
		);
		const factory = vi
			.fn()
			.mockReturnValueOnce({ initialize: () => firstCleanup })
			.mockReturnValueOnce({
				initialize: () => secondCleanup,
			});
		const entry = createAnyWidgetBundleDevelopmentEntry<TestState>(factory);
		const first = await widgetDefinition(entry.widget);
		const second = await widgetDefinition(entry.widget);
		await first.initialize?.(initializeProps(createModel({}), new AbortController().signal));
		await second.initialize?.(initializeProps(createModel({}), new AbortController().signal));

		const disposal = entry.dispose();
		await vi.waitFor(() => expect(secondCleanup).toHaveBeenCalledOnce());
		releaseCleanup();

		await expect(disposal).rejects.toThrow("first cleanup failed");
		expect(firstCleanup).toHaveBeenCalledOnce();
		expect(secondCleanup).toHaveBeenCalledOnce();
	});

	test("finishes view cleanup before initialization cleanup starts", async () => {
		let releaseViewCleanup!: () => void;
		const events: string[] = [];
		const initializeCleanup = vi.fn(() => {
			events.push("initialize");
		});
		const renderCleanup = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					events.push("view:start");
					releaseViewCleanup = () => {
						events.push("view:end");
						resolve();
					};
				}),
		);
		const entry = createAnyWidgetBundleDevelopmentEntry<TestState>({
			initialize: () => initializeCleanup,
			render: () => renderCleanup,
		});
		const definition = await widgetDefinition(entry.widget);
		const model = createModel({});
		await definition.initialize?.(initializeProps(model, new AbortController().signal));
		await definition.render?.(renderProps(model, document.createElement("div"), new AbortController().signal));

		const disposal = entry.dispose();
		await vi.waitFor(() => expect(renderCleanup).toHaveBeenCalledOnce());
		expect(events).toEqual(["view:start"]);
		releaseViewCleanup();
		await disposal;

		expect(events).toEqual(["view:start", "view:end", "initialize"]);
		expect(initializeCleanup).toHaveBeenCalledOnce();
	});

	test("waits for every rerender before surfacing a view failure", async () => {
		let releaseRender!: () => void;
		const lateCleanup = vi.fn();
		const nextRender = vi.fn(({ el }: RenderProps<TestState>) => {
			if (el.dataset.result === "failure") throw new Error("rerender failed");
			return new Promise<() => void>((resolve) => {
				releaseRender = () => resolve(lateCleanup);
			});
		});
		const entry = createAnyWidgetBundleDevelopmentEntry<TestState>({ render: vi.fn() });
		const definition = await widgetDefinition(entry.widget);
		const model = createModel({});
		await definition.initialize?.(initializeProps(model, new AbortController().signal));
		const failing = document.createElement("div");
		failing.dataset.result = "failure";
		const pending = document.createElement("div");
		pending.dataset.result = "pending";
		await definition.render?.(renderProps(model, failing, new AbortController().signal));
		await definition.render?.(renderProps(model, pending, new AbortController().signal));

		const update = entry.update({ render: nextRender });
		const rejection = expect(update).rejects.toThrow("rerender failed");
		await vi.waitFor(() => expect(nextRender).toHaveBeenCalledTimes(2));
		releaseRender();
		await rejection;
		await entry.dispose();

		expect(lateCleanup).toHaveBeenCalledOnce();
	});
});

async function widgetDefinition(widget: AnyWidget<TestState>) {
	return typeof widget === "function" ? await widget() : widget;
}
