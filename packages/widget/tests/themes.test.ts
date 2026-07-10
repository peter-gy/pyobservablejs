import { describe, expect, test } from "vite-plus/test";
import widget from "../src";
import { createHost, createModel, renderProps, waitFor } from "./testing";

describe("widget themes", () => {
	test("installs theme styles once in the widget owner root", () => {
		const host = document.createElement("div");
		const shadow = host.attachShadow({ mode: "open" });
		const first = document.createElement("div");
		const second = document.createElement("div");
		shadow.append(first, second);
		const firstController = new AbortController();
		const secondController = new AbortController();
		const headStyles = Array.from(document.head.querySelectorAll("style"));
		const modelState = {
			role: "notebook" as const,
			_spec: { cells: [] },
			_attachments: {},
			_variables: {},
			_options: {},
			_cell_widgets: [],
		};

		widget.render(renderProps(createModel(modelState), first, firstController.signal, createHost(new Map())));
		const [themeStyle] = Array.from(shadow.querySelectorAll("style"));
		expect(themeStyle).toBeInstanceOf(HTMLStyleElement);

		widget.render(renderProps(createModel(modelState), second, secondController.signal, createHost(new Map())));

		expect(Array.from(shadow.querySelectorAll("style"))).toEqual([themeStyle]);
		expect(Array.from(document.head.querySelectorAll("style"))).toEqual(headStyles);
		firstController.abort();
		secondController.abort();
	});

	test("rerenders the scoped notebook root when the theme trait changes", async () => {
		const model = createModel({
			role: "notebook",
			_spec: { theme: "air", cells: [] },
			theme: "air",
			_attachments: {},
			_variables: {},
			_options: {},
			_cell_widgets: [],
		});
		const controller = new AbortController();
		const el = document.createElement("div");

		widget.render(renderProps(model, el, controller.signal, createHost(new Map())));

		expect(await waitFor(() => notebookRoot(el))).toHaveProperty("dataset.theme", "air");

		model.set("theme", "slate");

		expect(
			await waitFor(() => {
				const root = notebookRoot(el);
				return root?.dataset.theme === "slate" ? root : undefined;
			}),
		).toHaveProperty("dataset.theme", "slate");
		controller.abort();
	});

	test("renders source-backed theme traits through the notebook widget", async () => {
		const model = createModel({
			role: "notebook",
			_source: '<!doctype html><notebook theme="air"></notebook>',
			theme: { light: "cotton", dark: "slate" },
			_attachments: {},
			_variables: {},
			_options: {},
			_cell_widgets: [],
		});
		const controller = new AbortController();
		const el = document.createElement("div");

		widget.render(renderProps(model, el, controller.signal, createHost(new Map())));

		const root = await waitFor(() => notebookRoot(el));

		expect(root.dataset.theme).toBe("light-dark");
		expect(root.dataset.themeLight).toBe("cotton");
		expect(root.dataset.themeDark).toBe("slate");
		controller.abort();
	});
});

function notebookRoot(el: HTMLElement): HTMLElement | undefined {
	const root = el.firstElementChild;
	return root instanceof HTMLElement ? root : undefined;
}
