import { describe, expect, test } from "vite-plus/test";
import { createNotebookFixture, renderProps, waitFor, widget } from "./testing";

describe("widget themes", () => {
	test("installs theme styles once in the widget owner root", async () => {
		const host = document.createElement("div");
		const shadow = host.attachShadow({ mode: "open" });
		const first = document.createElement("div");
		const second = document.createElement("div");
		shadow.append(first, second);
		const firstController = new AbortController();
		const secondController = new AbortController();
		const headStyles = Array.from(document.head.querySelectorAll("style"));
		const modelState = {
			_spec: { cells: [] },
			_attachments: {},
			_variables: {},
			_options: {},
		};
		const firstFixture = createNotebookFixture(modelState);
		const secondFixture = createNotebookFixture(modelState);

		widget.render(renderProps(firstFixture.view, first, firstController.signal, firstFixture.host));
		const themeStyle = await waitFor(() => shadow.querySelector("style") ?? undefined);
		expect(themeStyle).toBeInstanceOf(HTMLStyleElement);

		widget.render(renderProps(secondFixture.view, second, secondController.signal, secondFixture.host));

		await waitFor(() => (second.firstElementChild ? second.firstElementChild : undefined));
		expect(Array.from(shadow.querySelectorAll("style"))).toEqual([themeStyle]);
		expect(Array.from(document.head.querySelectorAll("style"))).toEqual(headStyles);
		firstController.abort();
		secondController.abort();
	});

	test("rerenders the scoped notebook root when the theme trait changes", async () => {
		const { session, view, host } = createNotebookFixture({
			_spec: { theme: "air", cells: [] },
			theme: "air",
			_attachments: {},
			_variables: {},
			_options: {},
		});
		const controller = new AbortController();
		const el = document.createElement("div");

		widget.render(renderProps(view, el, controller.signal, host));

		expect(await waitFor(() => notebookRoot(el))).toHaveProperty("dataset.theme", "air");

		session.set("theme", "slate");

		expect(
			await waitFor(() => {
				const root = notebookRoot(el);
				return root?.dataset.theme === "slate" ? root : undefined;
			}),
		).toHaveProperty("dataset.theme", "slate");
		controller.abort();
	});

	test("renders source-backed theme traits through NotebookView", async () => {
		const { view, host } = createNotebookFixture({
			_source: '<!doctype html><notebook theme="air"></notebook>',
			theme: { light: "cotton", dark: "slate" },
			_attachments: {},
			_variables: {},
			_options: {},
		});
		const controller = new AbortController();
		const el = document.createElement("div");

		widget.render(renderProps(view, el, controller.signal, host));

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
