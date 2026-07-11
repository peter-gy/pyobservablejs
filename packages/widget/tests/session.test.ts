import { expect, test } from "vite-plus/test";
import { createNotebookFixture, renderProps, variableValue, waitFor, widget } from "./testing";

test("ending the widget lifecycle stops runtime variable updates", async () => {
	const { session, view, host } = createNotebookFixture({
		_spec: { cells: [{ id: 1, mode: "ojs", value: "doubled = base * 2" }] },
		_attachments: {},
		_variables: { base: 2 },
		_options: {},
	});
	const controller = new AbortController();
	const el = document.createElement("div");
	widget.render(renderProps(view, el, controller.signal, host));
	await waitFor(() => (variableValue(view, "doubled") === 4 ? 4 : undefined));
	expect(session.listenerCount("change:_variable_update")).toBeGreaterThan(0);

	controller.abort();
	expect(session.listenerCount("change:_variable_update")).toBe(0);
	session.set("_variable_update", { seq: 1, kind: "set", values: { base: 5 } });

	expect(variableValue(view, "doubled")).toBe(4);
});
