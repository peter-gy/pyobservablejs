// @vitest-environment jsdom

import type { AnyModel } from "@anywidget/types";
import { afterEach, describe, expect, test } from "vitest";
import {
	loadAnyWidgetBundleApp,
	type AnyWidgetBundleApp,
	type AnyWidgetBundleAppModule,
} from "@/anywidget-bundle/runtime";
import { renderProps } from "@/_tests/testing";
import { respondingModel, type TestState } from "./testing";

const controllers: AbortController[] = [];

afterEach(() => {
	for (const controller of controllers.splice(0)) controller.abort();
});

describe("anywidget bundle runtime", () => {
	test("loads the app from the module default export", async () => {
		const backend = respondingModel(new Map([["chunks/app.js", `export default { render() {} };`]]));

		await expect(loadApp(backend.model, lifecycleSignal(), "default-export")).resolves.toMatchObject({
			render: expect.any(Function),
		});
		expect(backend.requested).toEqual(["chunks/app.js"]);
	});

	test("requires the app module to have a default export", async () => {
		const backend = respondingModel(new Map([["chunks/app.js", `export function render() {}`]]));

		await expect(loadApp(backend.model, lifecycleSignal(), "missing-default")).rejects.toThrow(
			"must have a default export",
		);
	});

	test("isolates module instances between widget models", async () => {
		const modules = new Map([
			[
				"chunks/app.js",
				`let count = 0;
				export default { render({ el }) { count += 1; el.textContent = String(count); } };`,
			],
		]);
		const first = respondingModel(modules);
		const second = respondingModel(modules);
		const firstSignal = lifecycleSignal();
		const secondSignal = lifecycleSignal();
		const firstApp = await loadApp(first.model, firstSignal, "first-model");
		const secondApp = await loadApp(second.model, secondSignal, "second-model");
		const firstEl = document.createElement("div");
		const secondEl = document.createElement("div");

		await firstApp.render(renderProps(first.model, firstEl, firstSignal));
		await firstApp.render(renderProps(first.model, firstEl, firstSignal));
		await secondApp.render(renderProps(second.model, secondEl, secondSignal));

		expect(firstEl.textContent).toBe("2");
		expect(secondEl.textContent).toBe("1");
	});

	test("releases the model transport when its lifecycle ends", async () => {
		const backend = respondingModel(new Map([["chunks/app.js", `export default { render() {} };`]]));
		const controller = trackedController();

		await loadAnyWidgetBundleApp(backend.model, "chunks/app.js", controller.signal, {
			createModuleUrl: () => "custom:app",
			importModule: async () => ({ default: { render() {} } }),
			revokeModuleUrl() {},
		});
		expect(backend.listenerCount).toBe(1);

		controller.abort();

		expect(backend.listenerCount).toBe(0);
	});
});

type RenderableApp = AnyWidgetBundleApp<TestState> & {
	render: NonNullable<AnyWidgetBundleApp<TestState>["render"]>;
};

async function loadApp(
	model: AnyModel<TestState>,
	signal: AbortSignal,
	scope: string,
	appPath = "chunks/app.js",
): Promise<RenderableApp> {
	const loaded = await loadAnyWidgetBundleApp<TestState>(model, appPath, signal, {
		createModuleUrl: (source, path) => dataModuleUrl(source, `${scope}-${path}`),
	});
	const app = await instantiate(loaded);
	if (!app.render) throw new Error("Expected a render lifecycle");
	return app as RenderableApp;
}

async function instantiate(module: AnyWidgetBundleAppModule<TestState>): Promise<AnyWidgetBundleApp<TestState>> {
	return typeof module === "function" ? await module() : module;
}

function dataModuleUrl(source: string, identity: string): string {
	return `data:text/javascript;base64,${btoa(source)}#${encodeURIComponent(identity)}`;
}

function lifecycleSignal(): AbortSignal {
	return trackedController().signal;
}

function trackedController(): AbortController {
	const controller = new AbortController();
	controllers.push(controller);
	return controller;
}
