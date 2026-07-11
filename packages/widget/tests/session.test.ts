import { expect, test } from "vite-plus/test";
import { createModel, renderProps, variableValue, waitFor, widget } from "./testing";

test("ending the widget lifecycle stops runtime variable updates", async () => {
	const model = createModel({
		role: "notebook",
		_spec: { cells: [{ id: 1, mode: "ojs", value: "doubled = base * 2" }] },
		_attachments: {},
		_variables: { base: 2 },
		_options: {},
	});
	const controller = new AbortController();
	const el = document.createElement("div");
	widget.render(renderProps(model, el, controller.signal));
	await waitFor(() => (variableValue(model, "doubled") === 4 ? 4 : undefined));
	expect(model.listenerCount("change:_variable_update")).toBeGreaterThan(0);

	controller.abort();
	expect(model.listenerCount("change:_variable_update")).toBe(0);
	model.set("_variable_update", { seq: 1, kind: "set", values: { base: 5 } });

	expect(variableValue(model, "doubled")).toBe(4);
});
