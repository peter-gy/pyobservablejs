import { describe, test } from "vite-plus/test";
import { alertText, composedText, createModel, renderProps, waitFor, widget } from "./testing";

describe("widget markdown rendering", () => {
	test("renders Python-authored Notebook Kit markdown cells", async () => {
		const model = createModel({
			role: "notebook",
			_spec: {
				cells: [{ id: 1, mode: "md", value: "# Python rows drive an Observable Plot bar chart" }],
			},
			_attachments: {},
			_variables: {},
			_options: {},
		});
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render(renderProps(model, el, controller.signal));

		await waitFor(() => {
			const error = alertText(el);
			if (error) throw new Error(error);
			return Array.from(el.querySelectorAll("h1")).find(
				(item) => item.textContent === "Python rows drive an Observable Plot bar chart",
			);
		});

		controller.abort();
	});

	test("renders source-backed OJS markdown through the Notebook Kit md builtin", async () => {
		const source =
			"<notebook>\n" +
			'  <script id="1" type="application/vnd.observable.javascript">md`**Rendered text**`</script>\n' +
			"</notebook>";
		const model = createModel({
			role: "notebook",
			_source: source,
			_attachments: {},
			_variables: {},
			_options: {},
		});
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render(renderProps(model, el, controller.signal));

		await waitFor(() => {
			const error = alertText(el);
			if (error) throw new Error(error);
			return onlyStrongText(el, "Rendered text");
		});

		controller.abort();
	});

	test("uses notebook-defined md bindings for source-backed OJS cells", async () => {
		const source =
			"<notebook>\n" +
			'  <script id="1" type="application/vnd.observable.javascript">md = (template) => `CUSTOM:${template[0]}`</script>\n' +
			'  <script id="2" type="application/vnd.observable.javascript">md`** custom**`</script>\n' +
			"</notebook>";
		const model = createModel({
			role: "notebook",
			_source: source,
			_attachments: {},
			_variables: {},
			_options: {},
		});
		const el = document.createElement("div");
		const controller = new AbortController();

		widget.render(renderProps(model, el, controller.signal));

		await waitFor(() => {
			const error = alertText(el);
			if (error) throw new Error(error);
			return onlyComposedInspectorString(el, "CUSTOM:** custom**");
		});

		controller.abort();
	});
});

function onlyStrongText(el: HTMLElement, text: string): HTMLElement | undefined {
	const matches = Array.from(el.querySelectorAll<HTMLElement>("strong")).filter((item) => item.textContent === text);
	if (matches.length === 0) return undefined;
	if (matches.length > 1) throw new Error(`Expected one strong element with ${text}, found ${matches.length}`);
	return matches[0];
}

function onlyComposedInspectorString(el: HTMLElement, value: string): HTMLElement | undefined {
	return composedText(el, value) ?? composedText(el, `"${value}"`);
}
